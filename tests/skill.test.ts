import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { registerAllTools } from "@/src/mcp/tools";
import { JUSTICE_COURT_CODES } from "@/src/sources/justice";

/**
 * skills/dawmain-reserse/SKILL.md is the research manual handed to the model,
 * and it is the one file nothing else references — so it rots silently. A tool
 * renamed or a parameter dropped leaves the skill teaching a call that fails,
 * and the failure surfaces mid-rešerše in front of a user. This pins the skill
 * to the surface the server actually registers.
 */

interface ToolShape {
  params: Set<string>;
  enums: Record<string, string[]>;
}

const tools: Record<string, ToolShape> = {};
registerAllTools({
  registerTool(name: string, config: Record<string, unknown>) {
    const input = config.inputSchema as z.ZodType | undefined;
    const schema = input
      ? (z.toJSONSchema(input, { io: "input" }) as { properties?: Record<string, Record<string, unknown>> })
      : undefined;
    const properties = schema?.properties ?? {};
    const enums: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(properties)) {
      const items = value.items as { enum?: string[] } | undefined;
      const candidate = (value.enum as string[] | undefined) ?? items?.enum;
      if (candidate?.length) enums[key] = candidate;
    }
    tools[name] = { params: new Set(Object.keys(properties)), enums };
  },
} as never);

const SKILL = readFileSync(
  path.join(path.dirname(__dirname), "skills", "dawmain-reserse", "SKILL.md"),
  "utf8",
);

/** Every parameter name any registered tool accepts. */
const everyParam = new Set(Object.values(tools).flatMap((tool) => [...tool.params]));

/**
 * affectedTypes values, verbatim from the SPA's own `affectedTypeNonNullUrl`
 * filter (HAR, 2026-09) and seen on live hits. The server does not filter on
 * them, so there is no constant to import — this list is the record, and what
 * keeps the skill from inventing a seventh.
 */
const AFFECTED_TYPES = ["CHANGE", "COMPLETE", "CONFIRM", "CORRECT", "REPLACE", "CANCEL"];

describe("SKILL.md is pinned to the registered tool surface", () => {
  it("names only tools that exist", () => {
    const named = [
      ...SKILL.matchAll(/\b((?:dawmain|esbirka|ns|nss|nalus|cz|justice|curia|eurlex|doctrine)_[a-z_]+)\b/g),
    ].map((match) => match[1]);
    expect(named.length).toBeGreaterThan(20);
    expect([...new Set(named)].filter((name) => !(name in tools))).toEqual([]);
  });

  it("names only parameters some tool accepts", () => {
    // Every `param: value` inside a backtick span — including the second and
    // third of a multi-parameter call, which is where a stale name hides.
    const used = [...SKILL.matchAll(/`([^`\n]+)`/g)].flatMap((span) =>
      [...span[1].matchAll(/(?:^|[\s,{(])([a-z][a-z_]{2,}):\s/g)].map((match) => match[1]),
    );
    expect(used.length).toBeGreaterThan(40);
    expect([...new Set(used)].filter((param) => !everyParam.has(param))).toEqual([]);
  });

  it("quotes only enum values the schemas accept", () => {
    // Checked where the skill spells a vocabulary out; a wrong value here is a
    // failed call, not a worse one.
    const cases: Array<[string, string, string[]]> = [
      ["justice_search", "types", ["JUDGEMENT", "RESOLUTION", "ORDER_T"]],
      ["justice_search", "match", ["all_words", "any_word", "phrase"]],
      ["justice_search", "sort", ["published", "decided"]],
      ["nss_search", "court", ["rozsireny-senat", "krajske"]],
      ["nalus_search", "types", ["nález"]],
      ["curia_search", "doc_type", ["judgment", "opinion", "avis"]],
      ["esbirka_search", "match", ["phrase", "all_words"]],
    ];
    for (const [tool, param, values] of cases) {
      const accepted = tools[tool].enums[param] ?? [];
      for (const value of values) {
        expect(accepted, `${tool}.${param}`).toContain(value);
        expect(SKILL, `${tool}.${param} = ${value}`).toContain(value);
      }
    }
  });

  it("lists only court codes justice_search accepts", () => {
    const section = SKILL.slice(SKILL.indexOf("## Obecné soudy"), SKILL.indexOf("## SDEU"));
    const known = new Set<string>(JUSTICE_COURT_CODES as readonly string[]);
    const quoted = [...section.matchAll(/`([A-Z]{2}[A-Z0-9]{1,6})`/g)]
      .map((match) => match[1])
      // The same section quotes the affectedTypes vocabulary in caps; those are
      // checked below, against their own source.
      .filter((token) => !AFFECTED_TYPES.includes(token));
    expect(quoted.length).toBeGreaterThan(10);
    expect(quoted.filter((code) => !known.has(code))).toEqual([]);
  });

  it("reads the affects vocabulary the API actually returns", () => {
    const section = SKILL.slice(SKILL.indexOf("## Obecné soudy"), SKILL.indexOf("## SDEU"));
    for (const value of AFFECTED_TYPES) expect(section).toContain(value);
  });
});
