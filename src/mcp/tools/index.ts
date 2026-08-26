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
import { registerEuipoClw } from "./euipo-clw";
import { registerEuipoGuidelines } from "./euipo-guidelines";

/**
 * Every tool the server exposes. To add one: create `./<name>.ts` exporting a
 * `register<Name>(server)` function and append it here.
 *
 * NOT registered: ./upv.ts — isdv.upv.gov.cz (and the legacy isdv.upv.cz)
 * drops TCP connections from datacenter IPs, verified from the fra1
 * deployment (probe canaries 'upv'/'upv-legacy' both fail with no HTTP
 * status). Re-add registerUpv here if a canary ever comes back healthy.
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
  registerEuipoClw,
  registerEuipoGuidelines,
];

export function registerAllTools(server: McpServer): void {
  for (const register of registrars) {
    register(server);
  }
}
