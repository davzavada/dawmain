import type { McpServer } from "@modelcontextprotocol/server";
import { registerPing } from "./ping";
import { registerProbe } from "./probe";
import { registerEsbirka } from "./esbirka";
import { registerNs } from "./ns";
import { registerNalus } from "./nalus";
import { registerNss } from "./nss";
import { registerCzCaselaw } from "./cz-caselaw";
import { registerCuria } from "./curia";
import { registerJustice } from "./justice";
import { registerEuipoClw } from "./euipo-clw";
import { registerEuipoGuidelines } from "./euipo-guidelines";
import { registerUpv } from "./upv";

/**
 * Every tool the server exposes. To add one: create `./<name>.ts` exporting a
 * `register<Name>(server)` function and append it here.
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
  registerEuipoClw,
  registerEuipoGuidelines,
  registerUpv,
];

export function registerAllTools(server: McpServer): void {
  for (const register of registrars) {
    register(server);
  }
}
