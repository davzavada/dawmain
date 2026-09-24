import type { McpServer } from "@modelcontextprotocol/server";
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
];

type ToolConfig = Record<string, unknown> & { outputSchema?: unknown };
type ToolResult = Record<string, unknown> & { structuredContent?: unknown };

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
 * requires structuredContent wherever one is declared.
 */
function textOnly(server: McpServer): McpServer {
  return {
    registerTool(name: string, config: ToolConfig, handler: (...args: unknown[]) => Promise<ToolResult>) {
      const { outputSchema: _structured, ...rest } = config;
      // A method call on the real server — registerTool relies on `this`.
      return (server as unknown as { registerTool: (...args: unknown[]) => unknown }).registerTool(
        name,
        rest,
        async (...args: unknown[]) => {
          const { structuredContent: _dropped, ...result } = await handler(...args);
          return result;
        },
      );
    },
  } as unknown as McpServer;
}

export function registerAllTools(server: McpServer): void {
  const target = textOnly(server);
  for (const register of registrars) {
    register(target);
  }
}
