import type { McpServer } from "@modelcontextprotocol/server";
import { registerEcho } from "./echo";
import { registerPing } from "./ping";

/**
 * Every tool the server exposes. To add one: create `./<name>.ts` exporting a
 * `register<Name>(server)` function and append it here.
 */
const registrars: Array<(server: McpServer) => void> = [registerPing, registerEcho];

export function registerAllTools(server: McpServer): void {
  for (const register of registrars) {
    register(server);
  }
}
