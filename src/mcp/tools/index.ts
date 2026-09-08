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
];

export function registerAllTools(server: McpServer): void {
  for (const register of registrars) {
    register(server);
  }
}
