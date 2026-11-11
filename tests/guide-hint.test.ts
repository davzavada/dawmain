import { describe, expect, it } from "vitest";
import { withGuideHint, isSearchTool } from "@/src/mcp/guide-hint";
import { registerAllTools } from "@/src/mcp/tools";
import type { McpServer } from "@modelcontextprotocol/server";

/**
 * Every tool that starts a search points at dawmain_guide in its own
 * description (ChatGPT does not follow the server instructions as reliably as
 * Claude). Pinned on the real registrations, so a new *_search tool is
 * covered or this fails.
 */

function registered(zotero: boolean): Array<{ name: string; description: string }> {
  const seen: Array<{ name: string; description: string }> = [];
  const server = {
    registerTool(name: string, config: { description?: string }) {
      seen.push({ name, description: config.description ?? "" });
    },
  } as unknown as McpServer;
  registerAllTools(server, { zotero });
  return seen;
}

describe("dawmain_guide pointer", () => {
  it("is in front of every search tool's description, and only there", () => {
    const tools = registered(true);
    const searches = tools.filter((t) => isSearchTool(t.name));
    expect(searches.map((t) => t.name).sort()).toEqual(
      ["caselaw_search", "doctrine_search", "esbirka_search", "eurlex_search", "files_search", "justice_search", "ns_search", "nss_search", "psp_search", "sdeu_search", "us_search", "zotero_search"].sort(),
    );
    for (const t of searches) expect(t.description.startsWith("FIRST, once per conversation: call dawmain_guide"), t.name).toBe(true);
    for (const t of tools.filter((t) => !isSearchTool(t.name))) expect(t.description.startsWith("FIRST, once per conversation"), t.name).toBe(false);
  });

  it("is added once and leaves other tools and descriptions alone", () => {
    const once = withGuideHint("ns_search", { description: "Search NS." });
    expect(withGuideHint("ns_search", once)).toBe(once);
    const read = { description: "Read a decision." };
    expect(withGuideHint("ns_get_decision", read)).toBe(read);
    const noText = {};
    expect(withGuideHint("ns_search", noText)).toBe(noText);
  });
});
