import { after } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";
import { clerkConfigured } from "./config";

/**
 * Per-user call counts, kept in Clerk's `privateMetadata`.
 *
 * Deliberately the smallest thing that gives an honest overview: how many
 * tool calls a user made, by month, and when they first connected. No
 * billing, no limits, no quotas — nothing here ever refuses a call, it only
 * records that one happened. Clerk is already the user store, so this needs
 * no database of its own.
 *
 * Only OAuth users can be counted: calls authenticated with the shared access
 * code have no user behind them and are skipped.
 *
 * Counting is best-effort by design. Writes happen after the response is sent
 * (see `countToolCall`), a lost increment costs nothing, and metadata is
 * read-modify-write, so two calls landing in the same millisecond on
 * different instances can collapse into one. An overview may therefore
 * undercount slightly; it must never delay or fail a tool call.
 */

/** Rolling window kept in metadata — a year of months is plenty for a table. */
const MONTHS_KEPT = 12;

export interface UsageRecord {
  /** Month key "2026-08" → number of tool calls. */
  months: Record<string, number>;
  /** ISO date of the first counted call. */
  since?: string;
}

/** Month key in Prague time, so a month rolls over at Czech midnight. */
export function monthKey(at: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    timeZone: "Europe/Prague",
  }).formatToParts(at);
  const year = parts.find((p) => p.type === "year")?.value ?? "0000";
  const month = parts.find((p) => p.type === "month")?.value ?? "00";
  return `${year}-${month}`;
}

/** Reads the usage object out of whatever Clerk holds, tolerating junk. */
export function parseUsage(privateMetadata: unknown): UsageRecord {
  const raw = (privateMetadata as { usage?: unknown } | null | undefined)?.usage;
  if (!raw || typeof raw !== "object") return { months: {} };
  const { months, since } = raw as { months?: unknown; since?: unknown };
  const parsed: Record<string, number> = {};
  if (months && typeof months === "object") {
    for (const [key, value] of Object.entries(months as Record<string, unknown>)) {
      if (typeof value === "number" && Number.isFinite(value) && /^\d{4}-\d{2}$/.test(key)) {
        parsed[key] = value;
      }
    }
  }
  return { months: parsed, ...(typeof since === "string" ? { since } : {}) };
}

/** The increment itself, pure — what the stored record becomes. */
export function withIncrement(current: UsageRecord, key = monthKey(), now = new Date()): UsageRecord {
  const months = { ...current.months, [key]: (current.months[key] ?? 0) + 1 };
  // Keep the window bounded: metadata is not a time series store.
  const kept = Object.keys(months)
    .sort()
    .slice(-MONTHS_KEPT);
  const trimmed: Record<string, number> = {};
  for (const month of kept) trimmed[month] = months[month];
  return { months: trimmed, since: current.since ?? now.toISOString().slice(0, 10) };
}

/** The userId an OAuth-authenticated request carries, if any. */
export function userIdFromAuth(authInfo: unknown): string | undefined {
  const extra = (authInfo as { extra?: Record<string, unknown> } | undefined)?.extra;
  const userId = extra?.userId;
  return typeof userId === "string" && userId ? userId : undefined;
}

/**
 * Serialize writes per user within this instance. Read-modify-write against
 * Clerk would otherwise drop increments whenever an agent fires several tool
 * calls in one turn — which is the normal case here.
 */
const pending = new Map<string, Promise<void>>();

async function increment(userId: string): Promise<void> {
  const client = await clerkClient();
  const user = await client.users.getUser(userId);
  const next = withIncrement(parseUsage(user.privateMetadata));
  await client.users.updateUserMetadata(userId, { privateMetadata: { usage: next } });
}

/**
 * Count one tool call. Never throws and never blocks the caller's result:
 * failures are logged and dropped, because a usage counter must not be able
 * to break a research query.
 */
export function countToolCall(authInfo: unknown): void {
  if (!clerkConfigured()) return;
  const userId = userIdFromAuth(authInfo);
  if (!userId) return;

  const previous = pending.get(userId) ?? Promise.resolve();
  // A serverless function may be frozen the moment it answers, which would
  // kill a bare floating promise. after() is what keeps the write alive past
  // the response; outside a request context (tests) it throws, and then the
  // plain promise below is all there is.
  const keepAlive = (work: Promise<void>) => {
    try {
      after(work);
    } catch {
      /* not in a request context — the promise still runs, best effort */
    }
  };
  const next = previous
    .catch(() => undefined)
    .then(() => increment(userId))
    .catch((error) => {
      console.warn("Nepodařilo se zapsat statistiku volání:", error);
    })
    .finally(() => {
      if (pending.get(userId) === next) pending.delete(userId);
    });
  pending.set(userId, next);
  keepAlive(next);
}

/** Everything the account page shows. */
export async function readUsage(userId: string): Promise<UsageRecord> {
  const client = await clerkClient();
  const user = await client.users.getUser(userId);
  return parseUsage(user.privateMetadata);
}
