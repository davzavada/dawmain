#!/usr/bin/env -S npx tsx
/**
 * CLI of the case-law mirror (docs/infra/v1-plan.md), run on LXC `app`:
 *
 *   npx tsx scripts/mirror.ts migrate [--dry-run]   apply src/mirror/db/migrations as mirror_owner
 *   npx tsx scripts/mirror.ts backfill --source us [--limit N] [--quarters 2004Q2,2024Q2]
 *                                                   without --quarters: from the cursor to today
 *   npx tsx scripts/mirror.ts status                per-source counts, last run, queue
 *
 * Planned (later steps of the plan): sync, reindex, api; backfill of ns,
 * nss, justice.
 *
 * Connection strings come from the environment or /etc/mirror/env
 * (MIRROR_ENV_FILE overrides the path).
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { migrate } from "./db-migrate.mjs";
import { closeMirrorPools, loadMirrorEnv, mirrorPool, mirrorUrl, poolDb } from "../src/mirror/db/client";
import { finishRun, startRun, type RunCounts } from "../src/mirror/db/store";
import { backfillUs, newUsPacer } from "../src/mirror/crawl/us";
import { SourceStopped } from "../src/mirror/http";
import { formatStatus, mirrorStatus } from "../src/mirror/status";

const MIRROR_MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "mirror",
  "db",
  "migrations",
);

const PLANNED: Record<string, string> = {
  sync: "krok 6",
  reindex: "krok 7",
  api: "krok 4",
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
  try {
    await backfillUs({ db, pacer: newUsPacer(), log }, { limit, quarters }, counts);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    log(e instanceof SourceStopped ? `us: ZASTAVENO — ${error}` : `us: běh selhal — ${error}`);
  } finally {
    await finishRun(db, runId, counts, error);
  }
  log(`us: hotovo — staženo ${counts.fetched}, nových/změněných ${counts.changed}, chyb ${counts.failed}`);
  return error ? 1 : 0;
}

async function runStatus(): Promise<void> {
  console.log(formatStatus(await mirrorStatus(mirrorPool("reader"))));
}

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  loadMirrorEnv();
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
  console.error("usage: mirror migrate [--dry-run] | backfill --source us [--limit N] [--quarters …] | status");
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    console.error(`mirror: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
