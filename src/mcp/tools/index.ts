import type { McpServer } from "@modelcontextprotocol/server";
import { registerPing } from "./ping";
import { registerProbe } from "./probe";
import { registerEsbirka } from "./esbirka";

/**
 * Every tool the server exposes. To add one: create `./<name>.ts` exporting a
 * `register<Name>(server)` function and append it here.
 */
const registrars: Array<(server: McpServer) => void> = [registerPing, registerProbe, registerEsbirka];

export function registerAllTools(server: McpServer): void {
  for (const register of registrars) {
    register(server);
  }
}
