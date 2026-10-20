import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { SKILL_MAX_CHARS, SKILL_PATH, SKILL_URL, loadSkill, registerGuide, resetSkillCache, skillBody } from "@/src/mcp/tools/guide";
import { INSTRUCTIONS } from "@/src/mcp/server";

/**
 * dawmain_guide (src/mcp/tools/guide.ts): the research manual served whole
 * by the connector — the same SKILL.md the repository versions, without its
 * front matter, small enough for one tool result, and named in the server
 * instructions so the model asks for it before a research.
 */

type Result = { isError?: boolean; content: Array<{ type: string; text: string }> };
type Handler = () => Promise<Result>;

function guide(): { handler: Handler; description: string } {
  let handler: Handler | undefined;
  let description = "";
  registerGuide({
    registerTool: (_name: string, config: { description: string }, h: Handler) => {
      handler = h;
      description = config.description;
    },
  } as never);
  return { handler: handler!, description };
}

const ROOT = path.dirname(__dirname);
const SKILL = readFileSync(path.join(ROOT, SKILL_PATH), "utf8");

afterEach(() => resetSkillCache());

describe("skillBody", () => {
  it("drops the YAML front matter and keeps the manual", () => {
    expect(skillBody("---\nname: x\ndescription: y\n---\n\n# Title\n\nBody")).toBe("# Title\n\nBody");
    expect(skillBody("# No front matter\n")).toBe("# No front matter");
    expect(skillBody(SKILL)).toMatch(/^# Rešerše přes Dawmain\n/);
    expect(skillBody(SKILL)).not.toContain("name: dawmain-reserse");
  });
});

describe("dawmain_guide", () => {
  it("answers with the whole manual from the repository tree", async () => {
    const result = await guide().handler();
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toBe(skillBody(SKILL));
    // Every source's section travels along — the point of serving it whole.
    for (const heading of ["## Tools", "## Poslanecká sněmovna", "## Nejvyšší soud", "## Obecné soudy", "## SDEU", "## Doktrína", "## The memo"]) {
      expect(text).toContain(heading);
    }
  });

  it("stays small enough for one tool result (grow past this and the answer needs sections)", () => {
    expect(skillBody(SKILL).length).toBeLessThan(SKILL_MAX_CHARS);
  });

  it("names the download address and carries on when the file is missing", async () => {
    await expect(loadSkill("/nonexistent-root")).rejects.toThrow();
    // A failed read is not cached: the next call reads again.
    resetSkillCache();
    expect(await loadSkill(ROOT)).toBe(skillBody(SKILL));
    expect(SKILL_URL).toBe("https://dawmain.davidzavada.cz/dawmain-reserse.md");
  });

  it("is the first call of a research by the server instructions and its own description", () => {
    expect(INSTRUCTIONS).toContain("MANUAL — at the start of every legal research call dawmain_guide ONCE");
    expect(INSTRUCTIONS).toContain('"najdi důvodovou zprávu"');
    expect(guide().description).toContain("Call it ONCE at the start of every legal research");
    expect(guide().description).toContain("nothing needs to be installed");
  });
});
