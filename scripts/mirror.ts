#!/usr/bin/env -S npx tsx
/**
 * CLI of the case-law mirror (docs/infra/v1-plan.md), run on LXC `app`:
 *
 *   npx tsx scripts/mirror.ts migrate [--dry-run]   apply src/mirror/db/migrations as mirror_owner
 *   npx tsx scripts/mirror.ts backfill --source us|ns|nss|justice|sdeu [--limit N]
 *                       [--quarters 2004Q2 (us)] [--months 2024-03 (nss)] [--days 2025-03-12 (justice)]
 *                       [--years 2019 (sdeu)]
 *                                                   without --quarters: from the cursor to today
 *   npx tsx scripts/mirror.ts reindex --source us   rebuild chunks and dissents from the stored text (no network)
 *   npx tsx scripts/mirror.ts sync [--source us] [--days 7] [--no-retry]
 *                                                   fetch_queue retry + the last days' publications
 *   npx tsx scripts/mirror.ts acts import [--skip-eu]  act registry from e-Sbírka and Cellar
 *   npx tsx scripts/mirror.ts provisions [--source us] [--limit N]  cited § / články of new, changed or stale decisions
 *                                                   (no network; sync runs it after each source)
 *   npx tsx scripts/mirror.ts status                per-source counts, last run, queue
 *   npx tsx scripts/mirror.ts api                   HTTP API on MIRROR_API_HOST:MIRROR_API_PORT
 *                                                   (default 127.0.0.1:8080), token MIRROR_API_TOKEN
 *
 * Connection strings come from the environment or /etc/mirror/env
 * (MIRROR_ENV_FILE overrides the path).
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { migrate } from "./db-migrate.mjs";
import { closeMirrorPools, loadMirrorEnv, mirrorPool, mirrorUrl, poolDb, type Db } from "../src/mirror/db/client";
import { finishRun, startRun, updateRun, type RunCounts, type RunMode } from "../src/mirror/db/store";
import { reindexSource } from "../src/mirror/reindex";
import { provisionsSource } from "../src/mirror/provisions";
import { loadActLookup } from "../src/mirror/legal/lookup";
import type { ActLookup } from "../src/mirror/legal/provisions";
import { retrySource, syncSource } from "../src/mirror/sync";
import { MIRROR_SOURCES, type MirrorSource } from "../src/mirror/types";
import { backfillUs, newUsPacer } from "../src/mirror/crawl/us";
import { backfillNs } from "../src/mirror/crawl/ns";
import { backfillNss } from "../src/mirror/crawl/nss";
import { backfillJustice } from "../src/mirror/crawl/justice";
import { backfillSdeu } from "../src/mirror/crawl/sdeu";
import { newPacer } from "../src/mirror/crawl/workers";
import { SourceStopped, pacedFetch } from "../src/mirror/http";
import { formatStatus, mirrorStatus } from "../src/mirror/status";
import { serve } from "@hono/node-server";
import { createMirrorApi } from "../src/mirror/api/server";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { euActsYearQuery, parseCellarActs, parseEsbirkaActs } from "../src/mirror/legal/registry";
import { manualRegistry, upsertActs, upsertAliases } from "../src/mirror/legal/store";

const MIRROR_MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "mirror",
  "db",
  "migrations",
);

/**
 * Exit status of a run the source stopped (429/403). mirror-backfill@.service
 * restarts after anything else (crash, network) but never after this one:
 * a human looks first (v1-plan, pravidlo 5).
 */
const EXIT_SOURCE_STOPPED = 3;

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const value = args[i + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
}

async function runMigrate(args: string[]): Promise<void> {
  const client = new pg.Client({ connectionString: mirrorUrl("owner"), application_name: "mirror-migrate" });
  await client.connect();
  try {
    // The mirror has no row-level security; mirror_owner is an ordinary role.
    await migrate(client, { dir: MIRROR_MIGRATIONS_DIR, dryRun: args.includes("--dry-run"), rlsCheck: false });
  } finally {
    await client.end();
  }
}

/**
 * Rate of a source: MIRROR_<SOURCE>_RPS and MIRROR_<SOURCE>_CONCURRENCY in
 * /etc/mirror/env, else the plan's defaults (1 req/s; NS at most 2 at once).
 */
function rate(source: "us" | "ns" | "nss" | "justice" | "sdeu", log: (line: string) => void): { rps: number; concurrency: number } {
  const key = source.toUpperCase();
  const rps = Number(process.env[`MIRROR_${key}_RPS`] ?? "1");
  const concurrency = Number(process.env[`MIRROR_${key}_CONCURRENCY`] ?? (source === "ns" ? "2" : "1"));
  if (!(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 8)) throw new Error(`MIRROR_${key}_CONCURRENCY must be 1–8`);
  log(`${source}: tempo ${rps} req/s, souběžně ${concurrency}`);
  return { rps, concurrency };
}

async function runBackfill(args: string[]): Promise<number> {
  const source = option(args, "--source");
  if (source !== "us" && source !== "ns" && source !== "nss" && source !== "justice" && source !== "sdeu") {
    console.error(`mirror backfill: neznámý zdroj ${source ?? "(chybí --source)"} (us, ns, nss, justice, sdeu)`);
    return 2;
  }
  const limitArg = option(args, "--limit");
  const limit = limitArg ? Number(limitArg) : undefined;
  if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) throw new Error("--limit must be a positive integer");
  const quarters = option(args, "--quarters")?.split(",").map((q) => q.trim());
  if (quarters && source !== "us") throw new Error("--quarters is for us only");
  const months = option(args, "--months")?.split(",").map((m) => m.trim());
  if (months && source !== "nss") throw new Error("--months is for nss only");
  const days = option(args, "--days")?.split(",").map((d) => d.trim());
  if (days && source !== "justice") throw new Error("--days is for justice only");
  const years = option(args, "--years")?.split(",").map((y) => Number(y.trim()));
  if (years && (source !== "sdeu" || years.some((y) => !Number.isInteger(y)))) throw new Error("--years is for sdeu only (e.g. 1998,2019)");

  return runTracked(source, "backfill", async (ctx, counts) => {
    const { rps, concurrency } = rate(source, ctx.log);
    if (source === "us") await backfillUs({ ...ctx, pacer: newUsPacer(rps) }, { limit, quarters, concurrency }, counts);
    else if (source === "ns") await backfillNs({ ...ctx, pacer: newPacer(rps) }, { limit, concurrency }, counts);
    else if (source === "nss") await backfillNss({ ...ctx, pacer: newPacer(rps) }, { limit, months, concurrency }, counts);
    else if (source === "justice") await backfillJustice({ ...ctx, pacer: newPacer(rps) }, { limit, days, concurrency }, counts);
    else await backfillSdeu({ ...ctx, pacer: newPacer(rps) }, { limit, years, concurrency }, counts);
  });
}

/**
 * Daily sync: for every source (or --source), first the due fetch_queue rows
 * (a "retry" run), then the last days' publications (a "sync" run). Each is
 * its own sync_run row; one source failing or stopped does not hold the
 * others back. Exit status: the worst of the runs (3 = a source stopped).
 */
/**
 * What the nightly sync keeps current. SDEU is not mirrored any more (removed
 * 26. 10.: its case law is read live through Cellar); `--source sdeu` still works.
 */
const SYNCED_SOURCES: readonly MirrorSource[] = ["us", "ns", "nss", "justice"];

async function runSync(args: string[]): Promise<number> {
  const only = option(args, "--source");
  if (only && !(MIRROR_SOURCES as readonly string[]).includes(only)) throw new Error(`unknown source ${only}`);
  const daysArg = option(args, "--days");
  const days = daysArg ? Number(daysArg) : undefined;
  if (days !== undefined && !(Number.isInteger(days) && days >= 1 && days <= 60)) throw new Error("--days must be 1–60");
  const sources = (only ? [only] : SYNCED_SOURCES) as MirrorSource[];
  let worst = 0;
  for (const source of sources) {
    for (const mode of ["retry", "sync"] as const) {
      if (mode === "retry" && args.includes("--no-retry")) continue;
      const code = await runTracked(source, mode, async (ctx, counts) => {
        const { rps, concurrency } = rate(source, ctx.log);
        const crawl = { ...ctx, pacer: newPacer(rps) };
        if (mode === "retry") await retrySource(crawl, source, concurrency, counts);
        else await syncSource(crawl, source, { days, concurrency }, counts);
      });
      worst = Math.max(worst, code);
      if (code === EXIT_SOURCE_STOPPED) break; // the source refused us: no sync after a stopped retry
    }
    // What the sync brought, read for cited provisions (no network).
    worst = Math.max(worst, await runProvisions(source));
  }
  return worst;
}

let actLookup: Promise<ActLookup> | null = null;

/** `mirror provisions`: decision_provision of new, changed or stale decisions of one source. */
async function runProvisions(source: MirrorSource, limit?: number): Promise<number> {
  actLookup ??= loadActLookup(mirrorPool("reader"));
  const lookup = await actLookup;
  return runTracked(source, "reindex", (ctx, counts) => provisionsSource(ctx, source, lookup, counts, limit));
}

/**
 * `mirror acts import`: the act registry — e-Sbírka's act list (downloaded
 * to MIRROR_DATA_DIR, default /srv/mirror-data, when missing or older than a
 * week), Cellar's EU acts year by year (--skip-eu leaves them), and the
 * hand-kept part. Idempotent.
 */
async function runActsImport(args: string[]): Promise<number> {
  const log = (line: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);
  const db = poolDb(mirrorPool("writer"));
  const dir = path.join(process.env.MIRROR_DATA_DIR ?? "/srv/mirror-data", "esbirka");
  const file = path.join(dir, "002PravniAkt.json.gz");
  const stale = !existsSync(file) || Date.now() - statSync(file).mtimeMs > 7 * 86_400_000;
  if (stale) {
    mkdirSync(dir, { recursive: true });
    const response = await fetch("https://opendata.eselpoint.gov.cz/datove-sady-esbirka/002PravniAkt.json.gz");
    if (!response.ok) throw new Error(`e-Sbírka answered HTTP ${response.status}`);
    writeFileSync(file, Buffer.from(await response.arrayBuffer()));
    log(`e-Sbírka: staženo ${file}`);
  }
  const items = JSON.parse(gunzipSync(readFileSync(file)).toString("utf8"))["položky"];
  const cz = parseEsbirkaActs(items);
  const actCount = await upsertActs(db, cz.acts);
  // Title names are derived from the titles alone: replaced whole, so a name the rules no longer give goes.
  const nameCount = await db.transaction(async (tx) => {
    await tx.query("DELETE FROM mirror.act_alias WHERE origin = 'title'");
    return upsertAliases(tx, cz.aliases);
  });
  log(`e-Sbírka: ${actCount} předpisů, ${nameCount} jmen`);

  if (!args.includes("--skip-eu")) {
    const pacer = newPacer(2);
    let total = 0;
    for (let year = 1952; year <= new Date().getUTCFullYear(); year++) {
      for (let attempt = 1; ; attempt++) {
        try {
          const url = `https://publications.europa.eu/webapi/rdf/sparql?query=${encodeURIComponent(euActsYearQuery(year))}`;
          const response = await pacedFetch("Cellar – registr", pacer, url, { headers: { accept: "application/sparql-results+json" }, timeoutMs: 180_000 });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          total += await upsertActs(db, parseCellarActs(await response.json()));
          break;
        } catch (error) {
          if (attempt >= 3) throw error;
          log(`EU ${year}: ${error instanceof Error ? error.message : String(error)}, znovu za 30 s`);
          await new Promise((r) => setTimeout(r, 30_000));
        }
      }
    }
    log(`CELLAR: ${total} unijních aktů`);
  }

  const manual = manualRegistry();
  await upsertActs(db, manual.acts);
  log(`ručně: ${manual.acts.length} předpisů, ${await upsertAliases(db, manual.aliases)} jmen a zkratek`);
  return 0;
}

async function runReindex(args: string[]): Promise<number> {
  const source = option(args, "--source");
  if (!source || !(MIRROR_SOURCES as readonly string[]).includes(source)) {
    console.error("mirror reindex: --source us | ns | nss | justice | sdeu");
    return 2;
  }
  return runTracked(source as MirrorSource, "reindex", (ctx, counts) => reindexSource(ctx, source as MirrorSource, counts));
}

/**
 * One run with its sync_run row: counts written every 50 decisions, the
 * end (or why it ended) recorded. SIGTERM / SIGINT (systemctl stop) asks the
 * work to stop after the decision in hand; the row then says "zastaveno".
 */
/**
 * Set once SIGTERM / SIGINT (systemctl stop) arrives — one listener for the
 * process, however many runs (a sync runs ten) it holds.
 */
let stopSignal: string | null = null;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    stopSignal = signal;
    console.log(`${new Date().toISOString().slice(11, 19)} ${signal} — dokončuji rozpracovaná rozhodnutí a končím`);
  });
}

async function runTracked(
  source: MirrorSource,
  mode: RunMode,
  work: (ctx: { db: Db; log: (line: string) => void; progress: (c: RunCounts) => Promise<void>; shouldStop: () => boolean }, counts: RunCounts) => Promise<void>,
): Promise<number> {
  const db = poolDb(mirrorPool("writer"));
  const counts: RunCounts = { fetched: 0, changed: 0, failed: 0 };
  const runId = await startRun(db, source, mode);
  const log = (line: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);
  const stopRequested = () => stopSignal;
  if (stopSignal) log(`${source}: přeskočeno — ${stopSignal}`);
  let reported = 0;
  const progress = async (c: RunCounts) => {
    const done = c.fetched + c.failed;
    if (done - reported < 50) return;
    reported = done;
    await updateRun(db, runId, c);
  };
  let error: string | null = null;
  let stopped = false;
  try {
    if (!stopRequested()) await work({ db, log, progress, shouldStop: () => stopRequested() !== null }, counts);
    if (stopRequested()) error = `zastaveno (${stopRequested()})`;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    stopped = e instanceof SourceStopped;
    log(e instanceof SourceStopped ? `${source}: ZASTAVENO — ${error}` : `${source}: běh selhal — ${error}`);
  } finally {
    await finishRun(db, runId, counts, error);
  }
  log(`${source}: ${mode} konec — zpracováno ${counts.fetched}, nových/změněných ${counts.changed}, chyb ${counts.failed}`);
  if (stopped) return EXIT_SOURCE_STOPPED;
  return error && !stopRequested() ? 1 : 0;
}

async function runStatus(): Promise<void> {
  console.log(formatStatus(await mirrorStatus(mirrorPool("reader"))));
}

/** Runs until SIGTERM / SIGINT (systemd stop), then closes the pool. */
async function runApi(): Promise<number> {
  const token = process.env.MIRROR_API_TOKEN?.trim() ?? "";
  const hostname = process.env.MIRROR_API_HOST?.trim() || "127.0.0.1";
  const port = Number(process.env.MIRROR_API_PORT ?? "8080");
  const app = createMirrorApi({ db: mirrorPool("reader"), token });
  const server = serve({ fetch: app.fetch, hostname, port }, (info) =>
    console.log(`mirror-api: listening on http://${info.address}:${info.port}`),
  );
  await new Promise<void>((resolve) => {
    for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => resolve());
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeMirrorPools();
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  loadMirrorEnv();
  if (command === "api") return runApi();
  try {
    if (command === "migrate") {
      await runMigrate(args);
      return 0;
    }
    if (command === "backfill") return await runBackfill(args);
    if (command === "reindex") return await runReindex(args);
    if (command === "provisions") {
      const only = option(args, "--source");
      if (only && !(MIRROR_SOURCES as readonly string[]).includes(only)) throw new Error(`unknown source ${only}`);
      const limitArg = option(args, "--limit");
      const limit = limitArg ? Number(limitArg) : undefined;
      if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1)) throw new Error("--limit must be a positive integer");
      let worst = 0;
      for (const source of (only ? [only] : SYNCED_SOURCES) as MirrorSource[]) worst = Math.max(worst, await runProvisions(source, limit));
      return worst;
    }
    if (command === "sync") return await runSync(args);
    if (command === "acts" && args[0] === "import") return await runActsImport(args.slice(1));
    if (command === "status") {
      await runStatus();
      return 0;
    }
  } finally {
    await closeMirrorPools();
  }
  console.error("usage: mirror migrate [--dry-run] | backfill --source us|ns|nss|justice|sdeu [--limit N] [--quarters …|--months …|--days …|--years …] | reindex --source … | sync [--source …] [--days N] | acts import | status | api");
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    console.error(`mirror: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
