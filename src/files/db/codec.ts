import "server-only";
import { deflateRawSync, inflateRawSync } from "node:zlib";

/**
 * Encoding helpers of the DB layer.
 *
 * Text blocks: the DMD is stored once, in ~12k-char doc_blocks, deflated in
 * the app (raw deflate, level 9 — about 0.3 of the UTF-8 size on Czech text,
 * against ~0.55 for Postgres' own lz4/pglz) into a `bytea` column with
 * STORAGE EXTERNAL, so Postgres never tries to compress it again. The server
 * slices text in JS and never needs SQL substr() on it.
 *
 * Row values: node-postgres and PGlite disagree on a few types (int8 and
 * numeric come back as strings from pg, bytea as Buffer vs Uint8Array,
 * timestamptz as Date in both), so repositories convert through these.
 *
 * Pure — unit-tested (tests/files-db-codec.test.ts).
 */

/** A single inflated block may never exceed this (blocks are ~12k chars ≈ 36 KB of UTF-8). */
export const MAX_INFLATED_BLOCK_BYTES = 4 * 1024 * 1024;

export function deflateText(s: string): Buffer {
  return deflateRawSync(Buffer.from(s, "utf8"), { level: 9 });
}

/** Inverse of deflateText. Throws on corrupt input or an output above MAX_INFLATED_BLOCK_BYTES. */
export function inflateText(b: Uint8Array): string {
  const input = Buffer.isBuffer(b) ? b : Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  return inflateRawSync(input, { maxOutputLength: MAX_INFLATED_BLOCK_BYTES }).toString("utf8");
}

/** timestamptz/date → ISO string (null stays null). */
export function isoOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

export function iso(v: unknown): string {
  return isoOrNull(v) ?? "";
}

/** int8 / numeric / count(*) → number (pg returns strings for those). */
export function num(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string" && v.trim() !== "") return Number(v);
  return 0;
}

export function numOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : num(v);
}

/** bytea → Uint8Array (a pg Buffer is one already). */
export function bytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  throw new TypeError("expected a bytea value");
}

/** jsonb parameter: always JSON text + an explicit ::jsonb cast. node-postgres
 *  would turn a JS array into a Postgres array literal, not JSON. */
export function jsonParam(value: unknown): string {
  return JSON.stringify(value === undefined ? null : value);
}

/** Cut a string to `max` UTF-16 units without leaving a lone high surrogate. */
export function capString(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max;
  const code = s.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return s.slice(0, end);
}
