import { describe, expect, it } from "vitest";
import { registerAllTools } from "@/src/mcp/tools";
import { justiceDecisionHeader } from "@/src/mcp/tools/justice";
import { isProcedurePaperwork } from "@/src/mcp/tools/eurlex";

/**
 * Clients read the text of an answer only (the structured half made Claude
 * Code show compact JSON instead of the curated text). What the model needs
 * must therefore be in the text — these pin the pieces that used to live in
 * structured output alone.
 */

describe("the registration boundary", () => {
  it("declares no outputSchema and returns no structuredContent", async () => {
    const seen: Array<{ name: string; config: Record<string, unknown>; handler: (args: unknown) => Promise<Record<string, unknown>> }> = [];
    registerAllTools({
      registerTool(name: string, config: Record<string, unknown>, handler: (args: unknown) => Promise<Record<string, unknown>>) {
        seen.push({ name, config, handler });
      },
    } as never);
    expect(seen.length).toBeGreaterThan(15);
    for (const tool of seen) expect(tool.config).not.toHaveProperty("outputSchema");
    const ping = seen.find((tool) => tool.name === "dawmain_ping");
    const result = await ping!.handler({});
    expect(result).not.toHaveProperty("structuredContent");
    expect((result.content as Array<{ text: string }>)[0].text).toContain('"server"');
  });
});

describe("justiceDecisionHeader", () => {
  // Metadata shape verbatim from a live justice_get_decision (2026-09).
  const metadata = {
    type: "JUDGEMENT",
    ecli: "ECLI:CZ:OSPM:2026:14.C.135.2026.1",
    publishedAt: "2026-09-22",
    decisionAt: "2026-07-29",
    caseNumber: { senate: 14, registry: "C", index: 135, year: 2026, pageNumber: 45 },
    solver: { titlesBefore: "JUDr.", firstName: "Hana", lastName: "Jelínková", titlesAfter: "", function: "samosoudkyně" },
    courtCode: "OSPM",
    caseResultType: ["VYHOVENI"],
    caseSubject: "o vyklizení bytu",
    affectedDocs: [
      { caseNumber: { senate: 8, registry: "C", index: 60, year: 2025 }, courtCode: "OSPM", affectedTypes: ["CONFIRM"] },
    ],
    regulations: [
      { paragraphNumber: "115a", lexNumber: 99, lexYear: 1963, lexType: "PREDPIS_ZAKON" },
      { paragraphNumber: "2291", lexNumber: 89, lexYear: 2012, lexType: "PREDPIS_ZAKON" },
    ],
  };

  it("puts the citation facts into the text", () => {
    const lines = justiceDecisionHeader(metadata);
    expect(lines[0]).toBe("14 C 135/2026-45 — OSPM — rozsudek — 2026-07-29");
    expect(lines).toContain("ECLI: ECLI:CZ:OSPM:2026:14.C.135.2026.1");
    expect(lines).toContain("Soudce: JUDr. Hana Jelínková (samosoudkyně)");
    expect(lines).toContain("Aplikované předpisy: § 115a 99/1963; § 2291 89/2012");
    expect(lines).toContain("Mění/potvrzuje: CONFIRM 8 C 60/2025 (OSPM)");
    expect(lines).toContain("Výsledek: VYHOVENI");
  });

  it("survives missing fields", () => {
    expect(justiceDecisionHeader({})).toEqual(["?"]);
  });
});

describe("isProcedurePaperwork", () => {
  it("separates procedure paperwork from the materials a reader argues from", () => {
    for (const type of ["ITEM_IA_NOTE", "NOTE_COVER", "NOTE", "VOTING_RES", "ACT_DRAFT", "STAT_REASON_DRAFT", "ADOPT_TEXT", "ACT_LEGIS", "NOTICE"]) {
      expect(isProcedurePaperwork(type), type).toBe(true);
    }
    for (const type of ["PROP_REG", "IMPACT_ASSESS_SUM", "OPIN", "RES_LEGIS", "POSIT", "STAT_REASON", "COMMUNIC_POSIT", "REPORT", "REG", "RECO", undefined]) {
      expect(isProcedurePaperwork(type), String(type)).toBe(false);
    }
  });
});
