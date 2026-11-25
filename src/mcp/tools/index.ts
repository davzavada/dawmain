import type { McpServer } from "@modelcontextprotocol/server";
import { CALL_BUDGET_MS, callStartedAt, runWithCallClock } from "@/src/sources/shared/clock";
import { registerPing } from "./ping";
import { registerProbe } from "./probe";
import { registerGuide } from "./guide";
import { registerEsbirka } from "./esbirka";
import { registerNs } from "./ns";
import { registerNalus } from "./nalus";
import { registerNss } from "./nss";
import { registerCzCaselaw } from "./cz-caselaw";
import { registerCaselawGet } from "./caselaw-get";
import { registerCitations } from "./citations";
import { registerCuria } from "./curia";
import { registerEurlex } from "./eurlex";
import { registerPsp } from "./psp";
import { registerSkPredpisy } from "./sk-predpisy";
import { registerSkLp } from "./sk-lp";
import { registerSkJudikatura } from "./sk-judikatura";
import { registerJustice } from "./justice";
import { registerDoctrine } from "./doctrine";
import { registerFiles } from "./files";
import { registerZotero } from "./zotero";
import { zoteroConfigured } from "@/src/zotero/config";
import { styled, type DescriptionStyle } from "../guide-hint";
import { trackToolCall } from "../usage";
import { admitToolCall, dailyLimitRefusal } from "../daily-limit";
import { mirrorConfigured } from "@/src/sources/mirror";
import { callerFromCtx } from "../caller";
import { MIRROR_TOOLS, type MirrorAnswer } from "./mirror-route";

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
 * InfoSoud (infosoud.gov.cz, the course of proceedings and právní moc) is
 * left out for the same reason: it answers an ordinary form query with
 * "Požadavek nebude zpracován. Vypadá jako odeslán robotem." (live 2026-11-20)
 * — the site refuses automated requests and nothing here works around that;
 * the skill sends the user there to check by hand.
 */
const registrars: Array<(server: McpServer) => void> = [
  registerPing,
  registerProbe,
  registerGuide,
  registerEsbirka,
  registerNs,
  registerNalus,
  registerNss,
  registerCzCaselaw,
  registerCaselawGet,
  registerCitations,
  registerJustice,
  registerCuria,
  registerEurlex,
  registerPsp,
  // Slovensko (slov-lex.sk): předpisy, legislativní proces, judikatura — docs/research/slovlex.md.
  registerSkPredpisy,
  registerSkLp,
  registerSkJudikatura,
  registerDoctrine,
  // Vlastní zdroje — the user's own uploads; gated per call (registration does no I/O).
  registerFiles,
];

type ToolConfig = Record<string, unknown> & { outputSchema?: unknown };
type ToolResult = Record<string, unknown> & { structuredContent?: unknown };
type ToolHandler = (...args: unknown[]) => Promise<ToolResult>;

/**
 * The whole invocation's budget. A call has a 60 s ceiling (the tools were
 * built for it on the former host and it stays; Cloudflare in front cuts any
 * request off at 100 s), and every upstream timeout is set per request:
 * chains of them add up past it (measured with every fetch hanging until its
 * own timeout: eurlex_search 61.5 s — a 30 s SPARQL POST retried at full
 * length; nss_search past page 1 ~71 s). A request cut off mid-stream — the
 * legacy transport has already answered 200 text/event-stream — leaves the
 * client a transport error with no text, no hint and none of the parts
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
/**
 * The case-law tools (MIRROR_TOOLS) read the home mirror for EVERY caller
 * wherever the deployment has one configured (MIRROR_API_URL + token):
 * answered from the mirror, or — when the mirror cannot answer this call
 * (a filter it does not index, a later page, a decision it does not hold,
 * an outage) — by the live tool, with the reason in front. There is no
 * per-account switch any more (removed 11/2026). Every other tool, and a
 * deployment without the mirror, goes straight to the live handler.
 */
async function routed(name: string, handler: ToolHandler, args: unknown[]): Promise<ToolResult> {
  const viaMirror = MIRROR_TOOLS[name];
  if (!viaMirror || !mirrorConfigured()) return handler(...args);
  let answer: MirrorAnswer;
  try {
    answer = await viaMirror((args[0] ?? {}) as Record<string, unknown>);
  } catch (error) {
    answer = { fallback: `the mirror failed (${error instanceof Error ? error.message : String(error)})` };
  }
  if (!("fallback" in answer)) return answer;
  const live = await handler(...args);
  const content = Array.isArray(live.content) ? (live.content as Array<{ type: string; text?: string }>) : [];
  const note = { type: "text", text: `[Mirror not used: ${answer.fallback} — answered live from the court.]` };
  return { ...live, content: [note, ...content] };
}

/**
 * The tool's title repeated as annotations.title. The spec allows the title
 * in both places; the Claude connector directory reads the annotation one
 * (its review flags every tool without it), older clients the top-level one.
 * Copied at this boundary so no tool file has to restate its title. Pure.
 */
export function withAnnotationTitle<T extends { title?: unknown; annotations?: unknown }>(config: T): T {
  if (typeof config.title !== "string") return config;
  const annotations = (config.annotations ?? {}) as Record<string, unknown>;
  if (typeof annotations.title === "string") return config;
  return { ...config, annotations: { title: config.title, ...annotations } };
}

function textOnly(server: McpServer, style: DescriptionStyle): McpServer {
  return {
    registerTool(name: string, config: ToolConfig, handler: ToolHandler) {
      const { outputSchema: _structured, ...bare } = config;
      const rest = withAnnotationTitle(styled(name, bare, style));
      // A method call on the real server — registerTool relies on `this`.
      return (server as unknown as { registerTool: (...args: unknown[]) => unknown }).registerTool(
        name,
        rest,
        async (...args: unknown[]) => {
          // args[1] is the request ctx (the caller's identity). An account over its daily limit is
          // answered here, before anything upstream is asked (src/mcp/daily-limit.ts) — not counted.
          if (!(await admitToolCall(name, args[1]))) return dailyLimitRefusal();
          // Counted once per call that runs, whatever its outcome.
          void trackToolCall(name, args[1]);
          // One line per call in the service log: how long the request waited before the tool started
          // (auth, the transport's handshake) and how long the tool took. "It is slow" could not be
          // placed without it — the sources answer in under a second, yet a call takes seconds end to end.
          const startedAt = Date.now();
          const waited = startedAt - callStartedAt();
          const { structuredContent: _dropped, ...result } = await withinBudget(name, () => routed(name, handler, args));
          console.info(`mcp tool ${name}: ${Date.now() - startedAt} ms (waited ${waited} ms before it)${result.isError ? " error" : ""}`);
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
 * on an event loop the server shares between concurrent requests, against
 * ~2.5 ms for replaying the recorded ones. Safe because the register
 * functions do nothing but call registerTool with constant configs (env is
 * read only inside handlers), and the SDK never mutates the config or schema
 * objects it is handed.
 */
const recorded = new Map<string, Registration[]>();

function registrations(zotero: boolean, style: DescriptionStyle): Registration[] {
  const key = `${zotero}:${style}`;
  let list = recorded.get(key);
  if (!list) {
    const acc: Registration[] = [];
    const recorder = textOnly({
      registerTool: (name: string, config: Record<string, unknown>, handler: ToolHandler) =>
        void acc.push([name, config, handler]),
    } as unknown as McpServer, style);
    for (const register of registrars) register(recorder);
    if (zotero) registerZotero(recorder);
    recorded.set(key, (list = acc));
  }
  return list;
}

/**
 * `zotero`: whether to offer the zotero_* tools (the user's own cloud Zotero
 * library — read, plus zotero_save that only creates — gated per call like
 * files_*). Only a deployment with the Zotero OAuth app and
 * CREDENTIALS_SECRET can connect a library at all;
 * elsewhere the tools stay out of tools/list, as their lines stay out of the
 * server instructions (buildInstructions in src/mcp/server.ts).
 * `style`: the wording of the descriptions (src/mcp/guide-hint.ts) — "plain"
 * unless the caller is ChatGPT.
 */
export function registerAllTools(
  server: McpServer,
  opts: { zotero: boolean; style?: DescriptionStyle } = { zotero: zoteroConfigured() },
): void {
  for (const [name, config, handler] of registrations(opts.zotero, opts.style ?? "plain")) {
    // A method call on the real server — registerTool relies on `this`.
    (server as unknown as { registerTool: (...args: unknown[]) => unknown }).registerTool(name, config, handler);
  }
}
