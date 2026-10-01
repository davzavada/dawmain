import type { McpServer } from "@modelcontextprotocol/server";
import { CALL_BUDGET_MS, callStartedAt, runWithCallClock } from "@/src/sources/shared/clock";
import { registerPing } from "./ping";
import { registerProbe } from "./probe";
import { registerEsbirka } from "./esbirka";
import { registerNs } from "./ns";
import { registerNalus } from "./nalus";
import { registerNss } from "./nss";
import { registerCzCaselaw } from "./cz-caselaw";
import { registerCuria } from "./curia";
import { registerEurlex } from "./eurlex";
import { registerJustice } from "./justice";
import { registerDoctrine } from "./doctrine";
import { registerFiles } from "./files";
import { registerZotero } from "./zotero";
import { zoteroConfigured } from "@/src/zotero/config";

/**
 * Every tool the server exposes. To add one: create `./<name>.ts` exporting a
 * `register<Name>(server)` function and append it here.
 *
 * Two sources are deliberately NOT covered, and no code for them is kept:
 * EUIPO (eSearchCLW, Guidelines), whose legal notices reserve and opt out of
 * "text or data mining, web scraping or similar reproductions … by any means,
 * including bots" outside scientific research — volume-agnostic, so even a few
 * interactive queries a day sit outside it; and ÚPV (isdv.upv.gov.cz), which
 * drops TCP connections from datacenter IPs, verified live from fra1. Clients
 * for both used to sit here dormant; they were unreachable code aging against
 * sites nobody was checking, so they went. Git history has them if either
 * source ever opens up, but by then they would want rewriting anyway.
 */
const registrars: Array<(server: McpServer) => void> = [
  registerPing,
  registerProbe,
  registerEsbirka,
  registerNs,
  registerNalus,
  registerNss,
  registerCzCaselaw,
  registerJustice,
  registerCuria,
  registerEurlex,
  registerDoctrine,
  // Vlastní zdroje — the user's own uploads; gated per call (registration does no I/O).
  registerFiles,
];

type ToolConfig = Record<string, unknown> & { outputSchema?: unknown };
type ToolResult = Record<string, unknown> & { structuredContent?: unknown };
type ToolHandler = (...args: unknown[]) => Promise<ToolResult>;

/**
 * The whole invocation's budget. app/api/mcp/route.ts runs with maxDuration
 * = 60 s, and every upstream timeout is set per request: chains of them add
 * up past it (measured with every fetch hanging until its own timeout:
 * eurlex_search 61.5 s — a 30 s SPARQL POST retried at full length;
 * nss_search past page 1 ~71 s). Vercel then kills the function mid-stream —
 * the legacy transport has already answered 200 text/event-stream — and the
 * client gets a transport error with no text, no hint and none of the parts
 * that did finish. Answering at 54 s leaves the response time to be written
 * and flushed. Counted from the HTTP request's arrival (runWithCallClock in
 * the route), so the auth round trip counts too; outside it (tests,
 * scripts) from the handler's start. The clock lives in
 * src/sources/shared/clock.ts, where the per-source budgets read it too
 * (callDeadline) and so end before this boundary answers for them.
 */
export { CALL_BUDGET_MS, runWithCallClock };

function overBudget(name: string): ToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text:
          `${name}: no answer within the ${Math.round(CALL_BUDGET_MS / 1000)} s one call may take here (the deployment's hard limit is 60 s) — ` +
          "an upstream database is answering very slowly or not at all. Narrow the call (filters, a date range, fewer query variants or pages) and call again; " +
          "dawmain_probe_sources tells whether the source is down.",
      },
    ],
  };
}

/**
 * Bound one handler by what is left of the call's budget. The handler keeps
 * running in the background (nothing here can cancel its fetches) — the
 * point is that the model gets a text answer instead of a killed stream.
 */
async function withinBudget(name: string, run: () => Promise<ToolResult>): Promise<ToolResult> {
  const left = callStartedAt() + CALL_BUDGET_MS - Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ToolResult>((resolve) => {
    timer = setTimeout(() => resolve(overBudget(name)), Math.max(0, left));
  });
  try {
    return await Promise.race([run(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Clients get the TEXT of every answer and nothing else. A result carrying
 * both halves is read differently by different clients: Claude Code hands
 * the model the structuredContent instead of the text (measured — the ping's
 * pretty-printed text arrived as compact JSON), so every hint that lives only
 * in the text (the justice.cz date window, continuation, variant failures)
 * never reached the model, and the JSON cost 14–160 % more tokens than the
 * curated text. Stripping here, at the one registration boundary, keeps the
 * handlers' structured output as their internal, unit-tested contract while
 * every client reads the same text. outputSchema goes with it: the spec
 * requires structuredContent wherever one is declared. Every handler is also
 * bounded by the call's budget here (CALL_BUDGET_MS).
 */
function textOnly(server: McpServer): McpServer {
  return {
    registerTool(name: string, config: ToolConfig, handler: ToolHandler) {
      const { outputSchema: _structured, ...rest } = config;
      // A method call on the real server — registerTool relies on `this`.
      return (server as unknown as { registerTool: (...args: unknown[]) => unknown }).registerTool(
        name,
        rest,
        async (...args: unknown[]) => {
          const { structuredContent: _dropped, ...result } = await withinBudget(name, () => handler(...args));
          return result;
        },
      );
    },
  } as unknown as McpServer;
}

type Registration = [name: string, config: Record<string, unknown>, handler: ToolHandler];

/**
 * The text-only registrations, recorded once per zotero flag. mcp-handler
 * builds a new McpServer for every HTTP request (the SDK's stateless model) —
 * initialize, notifications/initialized, tools/list and each tools/call —
 * and re-running every register* function rebuilt all tools' zod input and
 * output schemas each time: ~20 ms of CPU per request (measured, 29 tools),
 * on an event loop Fluid compute shares between concurrent requests, against
 * ~2.5 ms for replaying the recorded ones. Safe because the register
 * functions do nothing but call registerTool with constant configs (env is
 * read only inside handlers), and the SDK never mutates the config or schema
 * objects it is handed.
 */
const recorded = new Map<boolean, Registration[]>();

function registrations(zotero: boolean): Registration[] {
  let list = recorded.get(zotero);
  if (!list) {
    const acc: Registration[] = [];
    const recorder = textOnly({
      registerTool: (name: string, config: Record<string, unknown>, handler: ToolHandler) =>
        void acc.push([name, config, handler]),
    } as unknown as McpServer);
    for (const register of registrars) register(recorder);
    if (zotero) registerZotero(recorder);
    recorded.set(zotero, (list = acc));
  }
  return list;
}

/**
 * `zotero`: whether to offer the zotero_* tools (the user's own cloud Zotero
 * library, read-only, gated per call like files_*). Only a deployment with
 * the Zotero OAuth app and CREDENTIALS_SECRET can connect a library at all;
 * elsewhere the tools stay out of tools/list, as their lines stay out of the
 * server instructions (buildInstructions in src/mcp/server.ts).
 */
export function registerAllTools(server: McpServer, opts: { zotero: boolean } = { zotero: zoteroConfigured() }): void {
  for (const [name, config, handler] of registrations(opts.zotero)) {
    // A method call on the real server — registerTool relies on `this`.
    (server as unknown as { registerTool: (...args: unknown[]) => unknown }).registerTool(name, config, handler);
  }
}
