import { accessSync, constants } from "node:fs";
import { Pool } from "pg";

/**
 * Connections of the case-law mirror (docs/infra/v1-plan.md). It runs on the
 * home server under tsx, outside Next.js, against its own Postgres (LXC `pg`),
 * with one role per job: owner (migrations), writer (crawler), reader (API).
 * Connection strings live in /etc/mirror/env (mode 600) on LXC `app`, never
 * in the repo; systemd passes them as EnvironmentFile, and a hand-run CLI
 * loads the same file here.
 */

export type MirrorRole = "owner" | "writer" | "reader";

export const MIRROR_ENV_FILE = "/etc/mirror/env";

const URL_VARS: Record<MirrorRole, string> = {
  owner: "MIRROR_OWNER_URL",
  writer: "MIRROR_WRITER_URL",
  reader: "MIRROR_READER_URL",
};

/** API queries give up after 5 s (plan: timeout dotazu 5 s); crawler and migrations do not. */
export const READER_STATEMENT_TIMEOUT_MS = 5_000;

/**
 * Load MIRROR_ENV_FILE (or /etc/mirror/env) if present and readable;
 * variables already set win. A systemd service runs as the unprivileged
 * `mirror` user and gets the variables from EnvironmentFile (read by systemd
 * as root), so an unreadable file is skipped, not an error.
 */
export function loadMirrorEnv(file = process.env.MIRROR_ENV_FILE ?? MIRROR_ENV_FILE): void {
  try {
    accessSync(file, constants.R_OK);
  } catch {
    return;
  }
  process.loadEnvFile(file);
}

export function mirrorUrl(role: MirrorRole): string {
  const url = process.env[URL_VARS[role]]?.trim();
  if (!url) throw new Error(`${URL_VARS[role]} is not set (see ${MIRROR_ENV_FILE})`);
  return url;
}

/** What the mirror's queries need: pg's Pool / PoolClient and PGlite all fit. */
export interface Queryable {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: R[] }>;
}

/** A Queryable that can also run `fn` in one transaction on one connection. */
export interface Db extends Queryable {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
}

export function poolDb(pool: Pool): Db {
  return {
    query: (text, params) => pool.query(text, params) as never,
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(client as unknown as Queryable);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

const pools = new Map<MirrorRole, Pool>();

export function mirrorPool(role: Exclude<MirrorRole, "owner">): Pool {
  let pool = pools.get(role);
  if (!pool) {
    pool = new Pool({
      connectionString: mirrorUrl(role),
      application_name: `mirror-${role}`,
      max: role === "reader" ? 8 : 4,
      ...(role === "reader" ? { statement_timeout: READER_STATEMENT_TIMEOUT_MS } : {}),
    });
    pools.set(role, pool);
  }
  return pool;
}

export async function closeMirrorPools(): Promise<void> {
  const open = [...pools.values()];
  pools.clear();
  await Promise.all(open.map((p) => p.end()));
}
