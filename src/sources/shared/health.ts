/**
 * Passive health of the upstream databases.
 *
 * Every source client already goes through `fetchUpstream`, so the cheapest
 * possible status signal is the traffic that is happening anyway: each real
 * call records whether that source answered. Nothing here ever makes a
 * request of its own - the status page asks for a canary only when no real
 * call has been seen recently (see src/mcp/status.ts).
 *
 * Scope is one warm serverless instance: a cold start starts empty and the
 * page function does not share memory with the MCP function. That is why the
 * record carries its own timestamp - a consumer can tell "green as of 12:04"
 * from "nobody has asked this source on this instance yet".
 */

export interface SourceHealth {
  /** The SOURCE constant of the client, e.g. "Nejvyšší soud". */
  source: string;
  ok: boolean;
  /** Epoch ms of the observation. */
  at: number;
  /** Short reason when !ok - an HTTP status or the error name. */
  detail?: string;
}

const observations = new Map<string, SourceHealth>();

/** Called by `fetchUpstream` for every upstream request, success or failure. */
export function recordSourceResult(source: string, ok: boolean, detail?: string): void {
  observations.set(source, { source, ok, at: Date.now(), ...(detail ? { detail } : {}) });
}

/** Every observation this instance holds. */
export function allSourceResults(): SourceHealth[] {
  return [...observations.values()];
}
