import { describe, expect, it } from "vitest";
import { registerAllTools } from "@/src/mcp/tools";
import type { McpServer } from "@modelcontextprotocol/server";
import { GET as challenge } from "@/app/.well-known/openai-apps-challenge/route";

/**
 * The Claude and ChatGPT directories both require every tool to state
 * readOnlyHint, destructiveHint and openWorldHint explicitly (ChatGPT's
 * review imports them on "Scan Tools" and rejects a missing one). Pinned on
 * the real registrations, so a new tool without them fails here first.
 */
type Hints = { readOnlyHint?: unknown; destructiveHint?: unknown; openWorldHint?: unknown };

function registered(): Array<{ name: string; annotations?: Hints }> {
  const seen: Array<{ name: string; annotations?: Hints }> = [];
  const server = {
    registerTool(name: string, config: { annotations?: Hints }) {
      seen.push({ name, annotations: config.annotations });
    },
  } as unknown as McpServer;
  registerAllTools(server, { zotero: true });
  return seen;
}

describe("tool annotations", () => {
  it("every tool states all three hints as booleans", () => {
    const tools = registered();
    expect(tools.length).toBeGreaterThan(20);
    for (const t of tools) {
      for (const hint of ["readOnlyHint", "destructiveHint", "openWorldHint"] as const) {
        expect(typeof t.annotations?.[hint], `${t.name}.${hint}`).toBe("boolean");
      }
    }
  });

  it("only zotero_save writes, and nothing is destructive", () => {
    const tools = registered();
    expect(tools.filter((t) => t.annotations?.readOnlyHint === false).map((t) => t.name)).toEqual(["zotero_save"]);
    expect(tools.filter((t) => t.annotations?.destructiveHint === true)).toEqual([]);
  });
});

describe("OpenAI domain challenge", () => {
  it("is 404 while unset and the bare token once set", async () => {
    const before = process.env.OPENAI_APPS_CHALLENGE;
    delete process.env.OPENAI_APPS_CHALLENGE;
    expect(challenge().status).toBe(404);
    process.env.OPENAI_APPS_CHALLENGE = " tok_123 \n";
    const res = challenge();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("tok_123");
    if (before === undefined) delete process.env.OPENAI_APPS_CHALLENGE;
    else process.env.OPENAI_APPS_CHALLENGE = before;
  });
});
