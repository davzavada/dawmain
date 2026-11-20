import { withScope } from "@/src/files/db/client";
import { getSystemState, userCallsToday } from "@/src/files/db/usage";
import { envOnlyMode } from "@/src/files/guards";
import { callerFromCtx } from "./caller";
import { DAILY_CALL_LIMIT_KEY, DEFAULT_DAILY_CALL_LIMIT, parseDailyLimit } from "./daily-limit-config";

/**
 * The hard daily limit of tool calls per account: one registered account
 * must not hammer the courts' sites through this server. Counted across all
 * tools together, per UTC day — the day usage_daily counts in.
 *
 * Operator knowledge only. The figure is set in Správa → Systém and is shown
 * nowhere else: not on a user's page, not in dawmain_ping, not in a tool
 * description, and the refusal does not state it.
 *
 *   who       callers with an account (kind "user", per userId). The shared
 *             access code and anonymous local development are not limited.
 *             Admins get no exemption: telling one costs a Clerk request.
 *   which     every tool but EXEMPT_TOOLS — those reach no upstream and are
 *             what a client needs to find out what is wrong. They are
 *             neither refused nor counted.
 *   cost      no database round trip per call. The count lives in this
 *             process (one long-running Node server), per account and day,
 *             seeded ONCE per account and day from that account's
 *             usage_daily rows — so a restart or a deploy does not hand
 *             everyone a fresh day. The configured limit is read at most
 *             once a minute, and after the first read in the background.
 *   failure   bookkeeping never refuses a call: with the files database off
 *             or unconfigured, a seed that fails, or anything thrown here,
 *             the in-memory count (and the default limit) decide.
 *
 * A refused call is not counted and not written to usage_daily: a client
 * retrying against the limit must not turn into database writes.
 */

export {
  DAILY_CALL_LIMIT_KEY,
  DEFAULT_DAILY_CALL_LIMIT,
  MAX_DAILY_CALL_LIMIT,
  MIN_DAILY_CALL_LIMIT,
  parseDailyLimit,
  validDailyLimit,
} from "./daily-limit-config";

/** Never refused, never counted: no upstream request, and needed to diagnose. */
export const EXEMPT_TOOLS: readonly string[] = ["dawmain_ping", "dawmain_guide"];

/** The whole refusal. Deliberately without the figure. */
export const DAILY_LIMIT_MESSAGE = "Daily call limit reached for this account — try again tomorrow.";

const LIMIT_CACHE_MS = 60_000;
/** Neither read may hold a tool call for long. */
const READ_TIMEOUT_MS = 3_000;
const MAX_ACCOUNTS = 5_000;

/** The tool result of a call over the limit — shaped as the other tool errors. */
export function dailyLimitRefusal(): { isError: true; content: Array<{ type: "text"; text: string }> } {
  return { isError: true, content: [{ type: "text", text: DAILY_LIMIT_MESSAGE }] };
}

function databaseOn(): boolean {
  const mode = envOnlyMode();
  return mode === "on" || mode === "readonly";
}

// ---------------------------------------------------------------------------
// The configured limit, cached

let limitCache: { value: number; until: number } | null = null;
let limitRead: Promise<number> | null = null;
/** Bumped whenever the cache is set from outside, so a read in flight cannot overwrite it. */
let limitGeneration = 0;

function readLimit(now: number): Promise<number> {
  if (!limitRead) {
    const gen = limitGeneration;
    const run: Promise<number> = (async () => {
      // A failed read keeps what was known (else the default) for another minute.
      let value = limitCache?.value ?? DEFAULT_DAILY_CALL_LIMIT;
      if (databaseOn()) {
        try {
          const stored = await withScope([], (db) => getSystemState<unknown>(db, DAILY_CALL_LIMIT_KEY), { statementTimeoutMs: READ_TIMEOUT_MS });
          value = parseDailyLimit(stored) ?? DEFAULT_DAILY_CALL_LIMIT;
        } catch {
          // Unreachable database: the known value stands.
        }
      } else {
        value = DEFAULT_DAILY_CALL_LIMIT;
      }
      if (gen === limitGeneration) limitCache = { value, until: now + LIMIT_CACHE_MS };
      return limitCache?.value ?? value;
    })().finally(() => {
      if (limitRead === run) limitRead = null;
    });
    limitRead = run;
  }
  return limitRead;
}

/**
 * The limit in force. Known → answered at once; a stale value is still
 * answered at once and refreshed in the background. Only the first call of
 * the process waits for the read.
 */
function currentLimit(now: number): number | Promise<number> {
  if (limitCache) {
    if (now >= limitCache.until) void readLimit(now).catch(() => undefined);
    return limitCache.value;
  }
  return readLimit(now);
}

/** Správa saved a new limit (null = the default): this process applies it at once. */
export function noteDailyLimit(value: number | null, now = Date.now()): void {
  limitGeneration++;
  limitCache = { value: value ?? DEFAULT_DAILY_CALL_LIMIT, until: now + LIMIT_CACHE_MS };
}

// ---------------------------------------------------------------------------
// The count per account and day

interface Account {
  /** UTC day (YYYY-MM-DD) the entry counts. */
  day: string;
  /** Calls admitted by this process since the entry was made. */
  used: number;
  /** Calls the database already held for the day when the entry was made. */
  base: number;
  /** The seed in flight; concurrent calls of the account wait for the same one. */
  seeding: Promise<void> | null;
}

/** Insertion order doubles as LRU order (as the buckets of allowToolCall). */
const accounts = new Map<string, Account>();

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

async function seed(userId: string): Promise<number> {
  if (!databaseOn()) return 0;
  try {
    return await withScope([], (db) => userCallsToday(db, userId, EXEMPT_TOOLS), { statementTimeoutMs: READ_TIMEOUT_MS });
  } catch {
    return 0;
  }
}

function accountOf(userId: string, day: string): Account {
  let account = accounts.get(userId);
  if (account && account.day === day) {
    accounts.delete(userId); // re-insert: most recently used last
    accounts.set(userId, account);
    return account;
  }
  if (!account && accounts.size >= MAX_ACCOUNTS) {
    // An evicted account that calls again the same day is seeded again from the database.
    const oldest = accounts.keys().next().value;
    if (oldest !== undefined) accounts.delete(oldest);
  }
  accounts.delete(userId);
  const fresh: Account = { day, used: 0, base: 0, seeding: null };
  fresh.seeding = seed(userId).then((base) => {
    fresh.base = base;
    fresh.seeding = null;
  });
  accounts.set(userId, fresh);
  return fresh;
}

/**
 * Whether this call may run; an admitted call is counted. Asked in
 * textOnly() before the handler and before the call is written to
 * usage_daily (so the seed never sees the call it is admitting). Never
 * throws, and answers true whenever it cannot tell.
 */
export async function admitToolCall(tool: string, ctx: unknown, now = Date.now()): Promise<boolean> {
  try {
    if (EXEMPT_TOOLS.includes(tool)) return true;
    const caller = callerFromCtx(ctx);
    if (caller.kind !== "user") return true;
    const account = accountOf(caller.userId, utcDay(now));
    if (account.seeding) await account.seeding;
    const limit = await currentLimit(now);
    if (account.base + account.used >= limit) return false;
    account.used += 1;
    return true;
  } catch {
    return true;
  }
}

/** Tests: forget every count and the cached limit. */
export function __resetDailyLimitForTests(): void {
  accounts.clear();
  limitCache = null;
  limitRead = null;
  limitGeneration++;
}

/** Tests: how many accounts are held. */
export function __dailyLimitAccountsForTests(): number {
  return accounts.size;
}
