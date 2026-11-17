import { describe, expect, it } from "vitest";
import type { McpServer } from "@modelcontextprotocol/server";
import { registerAllTools } from "@/src/mcp/tools";
import { canaries } from "@/src/mcp/tools/probe";
import { DATABASE_GROUPS, DATABASES } from "@/src/mcp/databases";
import { buildInstructions } from "@/src/mcp/server";
import { SLOVLEX_LP, SLOVLEX_SUDY, SLOVLEX_ZBIERKA } from "@/src/sources/slovlex-base";

/**
 * The Slovak sources (slov-lex.sk) wired into the server: the eight sk_*
 * tools are registered, every database the home page lists under Slovensko
 * reports under its client's SOURCE constant and has a canary, and the
 * server instructions route to the three lanes (docs/research/slovlex-plan.md).
 */

const SK_TOOLS = [
  "sk_predpis_search",
  "sk_predpis_get_act",
  "sk_predpis_get_text",
  "sk_lp_search",
  "sk_lp_get_process",
  "sk_lp_get_text",
  "sk_judikatura_search",
  "sk_judikatura_get_decision",
];

function registeredNames(): string[] {
  const names: string[] = [];
  registerAllTools({ registerTool: (name: string) => void names.push(name) } as unknown as McpServer, { zotero: false });
  return names;
}

describe("Slovensko (slov-lex.sk) integration", () => {
  it("registers the eight sk_* tools, and no other sk_ tool", () => {
    const names = registeredNames();
    expect(names.filter((name) => name.startsWith("sk_")).sort()).toEqual([...SK_TOOLS].sort());
  });

  it("lists the Slovensko group last, each row with its SOURCE and a canary", () => {
    expect(DATABASE_GROUPS.at(-1)).toBe("Slovensko");
    const rows = DATABASES.filter((db) => db.group === "Slovensko");
    expect(Object.fromEntries(rows.map((db) => [db.canaryId, db.source]))).toEqual({
      "slovlex-zbierka": SLOVLEX_ZBIERKA,
      "slovlex-lp": SLOVLEX_LP,
      "slovlex-sudy": SLOVLEX_SUDY,
    });
    const all = canaries();
    for (const db of rows) {
      const canary = all.find((c) => c.id === db.canaryId);
      expect(canary, db.canaryId).toBeDefined();
      expect(canary!.source).toBe(db.source);
      expect(new URL(canary!.request().url).hostname).toMatch(/slov-lex\.sk$/);
    }
  });

  it("probes the static act history too, and keeps zotero last", () => {
    const ids = canaries().map((c) => c.id);
    expect(ids).toContain("slovlex-static");
    expect(ids[0]).toBe("esbirka-api");
    if (ids.includes("zotero")) expect(ids.at(-1)).toBe("zotero");
  });

  it("the server instructions carry the three sk_ lanes and keep them off Czech research", () => {
    for (const zotero of [false, true]) {
      const text = buildInstructions(zotero);
      expect(text.split("\n")[0]).toMatch(/^Czech, Slovak & EU legal research server/);
      expect(text).toMatch(/^- Slovak legislation .*sk_predpis_search → sk_predpis_get_act .*→ sk_predpis_get_text/m);
      expect(text).toMatch(/^- Slovak legislative process .*sk_lp_search → sk_lp_get_process .*→ sk_lp_get_text/m);
      expect(text).toMatch(/^- Slovak case law: sk_judikatura_search .*→ sk_judikatura_get_decision/m);
      expect(text).toContain("never as a default lane of Czech research");
      expect(text).toContain("Ústavný súd SR");
    }
  });
});
