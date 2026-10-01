import { AsyncLocalStorage } from "node:async_hooks";

/**
 * One clock for the whole MCP call. app/api/mcp/route.ts runs with
 * maxDuration = 60 s, and the registration boundary (src/mcp/tools/index.ts)
 * answers with a generic over-budget error at CALL_BUDGET_MS from the HTTP
 * request's arrival. The per-source budgets (ns_search's previews, NALUS,
 * Cellar) must end BEFORE that boundary — otherwise the wrapper answers first
 * and their partial results and source-specific hints are thrown away. They
 * used to count from the handler's start (55 s for NS/NALUS, past the 54 s
 * boundary; 50 s for Cellar with the auth round trip uncounted). Living here,
 * under src/sources, the clock is readable by the source clients as well as
 * by the tools without an import cycle through the tool registry.
 */

/** The whole invocation's budget, counted from the request's arrival. */
export const CALL_BUDGET_MS = 54_000;
/** What a source budget leaves before the boundary: rendering the answer
 * and writing it out, so the tool's own text wins the race. */
export const SOURCE_MARGIN_MS = 3_000;

const callClock = new AsyncLocalStorage<number>();

/** Run one HTTP request with its arrival time on record; the SDK dispatches
 * tool handlers inside this async context. */
export function runWithCallClock<T>(fn: () => T): T {
  return callClock.run(Date.now(), fn);
}

/** When the call started: the request's arrival inside the route, else now
 * (tests, scripts — the handler's start is the best clock there is). */
export function callStartedAt(): number {
  return callClock.getStore() ?? Date.now();
}

/**
 * The epoch ms by which a source budget of `budgetMs` starting now must end:
 * its own length, but never past SOURCE_MARGIN_MS before the call's boundary.
 */
export function callDeadline(budgetMs: number): number {
  return Math.min(Date.now() + budgetMs, callStartedAt() + CALL_BUDGET_MS - SOURCE_MARGIN_MS);
}
