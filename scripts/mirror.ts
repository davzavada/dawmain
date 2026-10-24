#!/usr/bin/env -S npx tsx
/**
 * CLI of the case-law mirror (docs/infra/v1-plan.md), run on LXC `app`:
 *
 *   npx tsx scripts/mirror.ts migrate [--dry-run]   apply src/mirror/db/migrations as mirror_owner
 *   npx tsx scripts/mirror.ts backfill --source us [--limit N] [--quarters 2004Q2,2024Q2]
 *                                                   without --quarters: from the cursor to today
 *   npx tsx scripts/mirror.ts status                per-source counts, last run, queue
 *   npx tsx scripts/mirror.ts api                   HTTP API on MIRROR_API_HOST:MIRROR_API_PORT
 *                                                   (default 127.0.0.1:8080), token MIRROR_API_TOKEN
 *
 * Planned (later steps of the plan): sync, reindex; backfill of ns, nss,
 * justice.
 *
 * Connection strings come from the environment or /etc/mirror/env
 * (MIRROR_ENV_FILE overrides the path).
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { migrate } from "./db-migrate.mjs";
import { closeMirrorPools, loadMirrorEnv, mirrorPool, mirrorUrl, poolDb } from "../src/mirror/db/client";
import { finishRun, startRun, updateRun, type RunCounts } from "../src/mirror/db/store";
import { backfillUs, newUsPacer } from "../src/mirror/crawl/us";
import { SourceStopped } from "../src/mirror/http";
import { formatStatus, mirrorStatus } from "../src/mirror/status";
import { serve } from "@hono/node-server";
import { createMirrorApi } from "../src/mirror/api/server";

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

const PLANNED: Record<string, string> = {
  sync: "krok 6",
  reindex: "krok 7",
};

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

async function runBackfill(args: string[]): Promise<number> {
  const source = option(args, "--source");
  if (source !== "us") {
    console.error(`mirror backfill: zdroj ${source ?? "(chybí --source)"} zatím není (v1: us; ns, nss, justice v kroku 5)`);
    return 2;
  }
  const limitArg = option(args, "--limit");
  const limit = limitArg ? Number(limitArg) : undefined;
  if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) throw new Error("--limit must be a positive integer");
  const quarters = option(args, "--quarters")?.split(",").map((q) => q.trim());

  const db = poolDb(mirrorPool("writer"));
  const counts: RunCounts = { fetched: 0, changed: 0, failed: 0 };
  const runId = await startRun(db, "us", "backfill");
  const log = (line: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);
  let error: string | null = null;
  let stopped = false;
  let reported = 0;
  const progress = async (c: RunCounts) => {
    const done = c.fetched + c.failed;
    if (done - reported < 50) return;
    reported = done;
    await updateRun(db, runId, c);
  };
  try {
    const rps = Number(process.env.MIRROR_US_RPS ?? "1");
    const concurrency = Number(process.env.MIRROR_US_CONCURRENCY ?? "1");
    if (!(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 8)) throw new Error("MIRROR_US_CONCURRENCY must be 1–8");
    log(`us: tempo ${rps} req/s, souběžně ${concurrency}`);
    await backfillUs({ db, pacer: newUsPacer(rps), log, progress }, { limit, quarters, concurrency }, counts);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    stopped = e instanceof SourceStopped;
    log(e instanceof SourceStopped ? `us: ZASTAVENO — ${error}` : `us: běh selhal — ${error}`);
  } finally {
    await finishRun(db, runId, counts, error);
  }
  log(`us: hotovo — staženo ${counts.fetched}, nových/změněných ${counts.changed}, chyb ${counts.failed}`);
  return stopped ? EXIT_SOURCE_STOPPED : error ? 1 : 0;
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
    if (command === "status") {
      await runStatus();
      return 0;
    }
  } finally {
    await closeMirrorPools();
  }
  if (command && command in PLANNED) {
    console.error(`mirror ${command}: zatím neimplementováno (${PLANNED[command]} plánu)`);
    return 2;
  }
  console.error("usage: mirror migrate [--dry-run] | backfill --source us [--limit N] [--quarters …] | status | api");
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    console.error(`mirror: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
