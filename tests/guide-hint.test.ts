import { describe, expect, it } from "vitest";
import { MODEL_INSTRUCTIONS, isSearchTool, plainDescription, withGuideHint, type DescriptionStyle } from "@/src/mcp/guide-hint";
import { isChatGpt } from "@/src/mcp/server";
import { registerAllTools } from "@/src/mcp/tools";
import type { McpServer } from "@modelcontextprotocol/server";

/**
 * Every tool that starts a search points at dawmain_guide in its own
 * description (ChatGPT does not follow the server instructions as reliably as
 * Claude). Pinned on the real registrations, so a new *_search tool is
 * covered or this fails.
 */

function registered(zotero: boolean, style: DescriptionStyle = "hinted"): Array<{ name: string; description: string }> {
  const seen: Array<{ name: string; description: string }> = [];
  const server = {
    registerTool(name: string, config: { description?: string }) {
      seen.push({ name, description: config.description ?? "" });
    },
  } as unknown as McpServer;
  registerAllTools(server, { zotero, style });
  return seen;
}

describe("dawmain_guide pointer", () => {
  it("is in front of every search tool's description, and only there", () => {
    const tools = registered(true);
    const searches = tools.filter((t) => isSearchTool(t.name));
    expect(searches.map((t) => t.name).sort()).toEqual(
      ["caselaw_search", "doctrine_search", "esbirka_search", "eurlex_search", "files_search", "justice_search", "ns_search", "nss_search", "psp_search", "sdeu_search", "sk_judikatura_search", "sk_lp_search", "sk_predpis_search", "us_search", "zotero_search"].sort(),
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

/**
 * Every other client (Claude) gets descriptions without instructions about
 * model behaviour or which tool to call first — a Claude connector directory
 * requirement. The guidance stays in the server instructions.
 */
describe("plain descriptions", () => {
  const BANNED = /FIRST, once per conversation|without asking|never ask the user|Call it ONCE|in the same turn as your first/i;

  it("carry no model instructions, while the hinted ones keep them", () => {
    const plain = registered(true, "plain");
    expect(plain.length).toBeGreaterThan(30);
    for (const t of plain) expect(BANNED.test(t.description), `${t.name}: ${t.description.match(BANNED)?.[0]}`).toBe(false);
    const hinted = registered(true, "hinted");
    expect(hinted.some((t) => BANNED.test(t.description))).toBe(true);
  });

  it("every replaced sentence still occurs in the sources", () => {
    const all = registered(true, "hinted").map((t) => t.description).join("\n");
    for (const [from] of MODEL_INSTRUCTIONS) expect(all.includes(from), from.slice(0, 60)).toBe(true);
  });

  it("only the instructions change: plain = hinted without the pointer, minus those sentences", () => {
    const hinted = registered(true, "hinted");
    const plain = registered(true, "plain");
    hinted.forEach((t, i) => {
      const source = t.description.replace(/^FIRST, once per conversation: call dawmain_guide[^.]*\. /, "");
      expect(plain[i].description).toBe(plainDescription(source));
    });
  });

  it("ChatGPT is told apart by its User-Agent", () => {
    const req = (ua?: string) => new Request("http://x/api/mcp", { headers: ua ? { "user-agent": ua } : {} });
    expect(isChatGpt(req("openai-mcp/1.0.0"))).toBe(true);
    expect(isChatGpt(req("Mozilla/5.0 ChatGPT-User/1.0"))).toBe(true);
    expect(isChatGpt(req("Claude-User"))).toBe(false);
    expect(isChatGpt(req("node"))).toBe(false);
    expect(isChatGpt(req())).toBe(false);
  });
});
