import "server-only";
import { Pool, type PoolClient } from "pg";
import { attachDatabasePool } from "@vercel/functions";
import { LIBRARY_ID_RE, databaseUrl } from "../config";

/**
 * The one door to the database. Every query runs inside `withScope`: a
 * transaction on ONE pooled connection that first sets the transaction-local
 * `app.library_ids` (the libraries the caller may touch — computed on the
 * server from Clerk, never taken from input). Row-level security on every
 * content table reads that setting, so a forgotten WHERE returns nothing
 * instead of another library's rows. Transaction-local (`set_config(…, true)`)
 * is what makes this safe under PgBouncer transaction pooling and under
 * Fluid compute, where one warm instance serves many users at once: a
 * session-level SET would leak to whoever borrows the connection next.
 */

/** What repositories need: pg's PoolClient and PGlite both satisfy it. */
export interface Queryable {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: R[] }>;
}

export interface ScopeOptions {
  /** Default 10 s (a suspended Neon compute must fail fast, not hang the MCP call). */
  statementTimeoutMs?: number;
}

export type ScopeRunner = <T>(
  libraryIds: readonly string[],
  fn: (db: Queryable) => Promise<T>,
  options?: ScopeOptions,
) => Promise<T>;

/** Raised when the database is not usable — unconfigured, unsafe role, unreachable. */
export class FilesUnavailableError extends Error {
  constructor(
    message: string,
    public readonly reason: "unconfigured" | "unsafe_role" | "unreachable",
  ) {
    super(message);
    this.name = "FilesUnavailableError";
  }
}

let override: ScopeRunner | null = null;

/** Tests swap the runner for a PGlite-backed one (tests/helpers/pglite.ts). */
export function setScopeRunner(runner: ScopeRunner | null): void {
  override = runner;
}

let pool: Pool | null = null;
let roleCheck: Promise<void> | null = null;
let lastActivityMark = 0;

function getPool(): Pool {
  if (pool) return pool;
  const connectionString = databaseUrl();
  if (!connectionString) {
    throw new FilesUnavailableError("FILES_DATABASE_URL is not set", "unconfigured");
  }
  pool = new Pool({
    connectionString,
    max: 5,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 4_000,
    statement_timeout: 10_000,
  });
  // On Fluid compute, closes idle clients before the instance is suspended.
  attachDatabasePool(pool);
  return pool;
}

/**
 * Refuse to run as a role that ignores RLS. On Neon every role created in
 * the Console/API (the owner included) is a member of neon_superuser and
 * bypasses row-level security; only a role created by SQL is safe. Checked
 * once per instance, on the first connection.
 */
async function verifyRole(client: PoolClient): Promise<void> {
  const { rows } = await client.query<{
    rolsuper: boolean;
    rolbypassrls: boolean;
    neon_superuser: boolean;
    read_all: boolean;
  }>(
    `SELECT r.rolsuper, r.rolbypassrls,
            coalesce((SELECT pg_has_role(current_user, 'neon_superuser', 'member')
                        WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'neon_superuser')), false) AS neon_superuser,
            pg_has_role(current_user, 'pg_read_all_data', 'member') AS read_all
       FROM pg_roles r WHERE r.rolname = current_user`,
  );
  const row = rows[0];
  if (!row || row.rolsuper || row.rolbypassrls || row.neon_superuser || row.read_all) {
    console.error("files: FILES_DATABASE_URL uses a role that bypasses row-level security — refusing all file queries");
    throw new FilesUnavailableError("database role bypasses row-level security", "unsafe_role");
  }
}

function assertLibraryIds(ids: readonly string[]): void {
  for (const id of ids) {
    if (!LIBRARY_ID_RE.test(id)) throw new Error(`invalid library id in scope: ${JSON.stringify(id)}`);
  }
}

/**
 * Run `fn` in one transaction scoped to `libraryIds`. An empty list is the
 * system scope: no content rows are visible, only the SECURITY DEFINER
 * functions (aggregates, ids) and the counter tables.
 */
export async function withScope<T>(
  libraryIds: readonly string[],
  fn: (db: Queryable) => Promise<T>,
  options: ScopeOptions = {},
): Promise<T> {
  assertLibraryIds(libraryIds);
  if (override) return override(libraryIds, fn, options);

  let client: PoolClient;
  try {
    client = await getPool().connect();
  } catch (error) {
    if (error instanceof FilesUnavailableError) throw error;
    throw new FilesUnavailableError(`database unreachable: ${(error as Error).message}`, "unreachable");
  }
  let failed: Error | undefined;
  try {
    if (!roleCheck) roleCheck = verifyRole(client);
    try {
      await roleCheck;
    } catch (error) {
      // An unsafe role stays refused for this instance; a transient failure
      // of the check itself is retried on the next call.
      if (!(error instanceof FilesUnavailableError && error.reason === "unsafe_role")) roleCheck = null;
      throw error;
    }
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.library_ids', $1, true)", [libraryIds.join(",")]);
    if (options.statementTimeoutMs) {
      await client.query("SELECT set_config('statement_timeout', $1, true)", [String(options.statementTimeoutMs)]);
    }
    const now = Date.now();
    if (now - lastActivityMark > 60_000) {
      lastActivityMark = now;
      // One row per minute in which the DB was awake: the in-app estimate of
      // Neon compute hours (the consumption API is paid-plan only).
      await client.query(
        "INSERT INTO db_activity (minute) VALUES (date_trunc('minute', now())) ON CONFLICT DO NOTHING",
      );
    }
    const result = await fn(client as unknown as Queryable);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    failed = error instanceof Error ? error : new Error(String(error));
    try {
      await client.query("ROLLBACK");
    } catch {
      // The connection is destroyed below anyway.
    }
    throw error;
  } finally {
    // release(err) destroys the connection: never hand a half-open
    // transaction (with another user's scope set) to the next borrower.
    client.release(failed);
  }
}

/** Test hook: forget the pool and the role verdict. */
export function __resetForTests(): void {
  pool = null;
  roleCheck = null;
  lastActivityMark = 0;
}
