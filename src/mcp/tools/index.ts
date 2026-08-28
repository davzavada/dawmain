import type { McpServer } from "@modelcontextprotocol/server";
import { registerPing } from "./ping";
import { registerProbe } from "./probe";
import { registerEsbirka } from "./esbirka";
import { registerNs } from "./ns";
import { registerNalus } from "./nalus";
import { registerNss } from "./nss";
import { registerCzCaselaw } from "./cz-caselaw";
import { registerCzCaselawGet } from "./cz-caselaw-get";
import { registerCuria } from "./curia";
import { registerEurlex } from "./eurlex";
import { registerJustice } from "./justice";

/**
 * Every tool the server exposes. To add one: create `./<name>.ts` exporting a
 * `register<Name>(server)` function and append it here.
 *
 * NOT registered: ./euipo-clw.ts and ./euipo-guidelines.ts — EUIPO's legal
 * notices expressly reserve and opt out of "text or data mining, web scraping
 * or similar reproductions … by any means, including bots, scrapers or other
 * automated processes" for anything other than scientific research, and forbid
 * extracting substantial parts of its databases. That reservation is
 * volume-agnostic, so even a handful of interactive queries a day sits outside
 * it. The clients stay in the tree, dormant, in case EUIPO ever grants written
 * authorisation or publishes case law through its API Portal.
 *
 * NOT registered: ./upv.ts — isdv.upv.gov.cz (and the legacy isdv.upv.cz)
 * drops TCP connections from datacenter IPs, verified live from the fra1
 * deployment. Its probe canaries were removed as dead noise; re-add
 * registerUpv here only after verifying by hand that the host accepts
 * connections from the deployment again.
 */
const registrars: Array<(server: McpServer) => void> = [
  registerPing,
  registerProbe,
  registerEsbirka,
  registerNs,
  registerNalus,
  registerNss,
  registerCzCaselaw,
  registerCzCaselawGet,
  registerJustice,
  registerCuria,
  registerEurlex,
];

export function registerAllTools(server: McpServer): void {
  for (const register of registrars) {
    register(server);
  }
}
