#!/usr/bin/env -S npx tsx
/**
 * CLI of the case-law mirror (docs/infra/v1-plan.md), run on LXC `app`:
 *
 *   npx tsx scripts/mirror.ts migrate [--dry-run]   apply src/mirror/db/migrations as mirror_owner
 *
 * Planned (later steps of the plan): backfill --source, sync, reindex,
 * status, api.
 *
 * Connection strings come from the environment or /etc/mirror/env
 * (MIRROR_ENV_FILE overrides the path).
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { migrate } from "./db-migrate.mjs";
import { loadMirrorEnv, mirrorUrl } from "../src/mirror/db/client";

const MIRROR_MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "mirror",
  "db",
  "migrations",
);

const PLANNED: Record<string, string> = {
  backfill: "krok 3 (pilot) a 5",
  sync: "krok 6",
  reindex: "krok 7",
  status: "krok 3",
  api: "krok 4",
};

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

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  loadMirrorEnv();
  if (command === "migrate") {
    await runMigrate(args);
    return 0;
  }
  if (command && command in PLANNED) {
    console.error(`mirror ${command}: zatím neimplementováno (${PLANNED[command]} plánu)`);
    return 2;
  }
  console.error("usage: mirror migrate [--dry-run]");
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    console.error(`mirror: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
