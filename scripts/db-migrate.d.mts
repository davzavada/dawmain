/** Types of scripts/db-migrate.mjs for TypeScript callers (scripts/mirror.ts). */

export interface MigrateClient {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export interface MigrationFile {
  filename: string;
  sha256: string;
  sql: string;
}

export const MIGRATIONS_DIR: string;
export const LOCK_KEY: number;
export function sha256(text: string): string;
export function readMigrations(dir?: string): MigrationFile[];
export function plan(
  files: MigrationFile[],
  applied: Array<{ filename: string; sha256: string }>,
): { pending: MigrationFile[]; missing: string[] };
export function assertOwnerBypassesRls(client: MigrateClient): Promise<void>;
export function migrate(
  client: MigrateClient,
  options?: { dir?: string; dryRun?: boolean; rlsCheck?: boolean; log?: (line: string) => void },
): Promise<{ applied: string[]; pending: string[] }>;
