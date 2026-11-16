import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { __setAccessLoaderForTests, emptyAccess, type Access } from "@/src/files/access";
import {
  GATED_SECTIONS,
  SKILL_MAX_CHARS,
  SKILL_PATH,
  SKILL_URL,
  loadSkill,
  registerGuide,
  resetSkillCache,
  skillBody,
  tailorManual,
  unavailableSources,
} from "@/src/mcp/tools/guide";
import { INSTRUCTIONS } from "@/src/mcp/server";

/**
 * dawmain_guide (src/mcp/tools/guide.ts): the research manual served whole
 * by the connector — the same SKILL.md the repository versions, without its
 * front matter, small enough for one tool result, and named in the server
 * instructions so the model asks for it before a research.
 */

type Result = { isError?: boolean; content: Array<{ type: string; text: string }> };
type Handler = (args?: unknown, ctx?: unknown) => Promise<Result>;

const USER = "user_2abcDEF123456789";
const USER_CTX = { http: { authInfo: { token: "t", clientId: "client_1", scopes: [], extra: { userId: USER } } } };
const SHARED_CTX = { http: { authInfo: { token: "t", clientId: "shared-token", scopes: [], extra: { method: "token" } } } };
const LIBRARY = { id: USER, name: "Osobní", role: "owner" } as unknown as Access["libraries"][number];
/** An account with everything switched on. */
const FULL: Access = { userId: USER, banned: false, libraries: [LIBRARY], all: [LIBRARY], zotero: true, ukaz: true };
const ZOTERO_ENV = ["ZOTERO_OAUTH_CLIENT_KEY", "ZOTERO_OAUTH_CLIENT_SECRET", "CREDENTIALS_SECRET", "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "CLERK_SECRET_KEY"];

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

afterEach(() => {
  resetSkillCache();
  __setAccessLoaderForTests(null);
  delete process.env.FILES_MODE;
  delete process.env.FILES_DATABASE_URL;
  for (const name of ZOTERO_ENV) delete process.env[name];
});

describe("skillBody", () => {
  it("drops the YAML front matter and keeps the manual", () => {
    expect(skillBody("---\nname: x\ndescription: y\n---\n\n# Title\n\nBody")).toBe("# Title\n\nBody");
    expect(skillBody("# No front matter\n")).toBe("# No front matter");
    expect(skillBody(SKILL)).toMatch(/^# Rešerše přes Dawmain\n/);
    expect(skillBody(SKILL)).not.toContain("name: dawmain-reserse");
  });
});

describe("dawmain_guide", () => {
  it("answers with the manual from the repository tree — whole when nothing is gated off", async () => {
    expect(tailorManual(skillBody(SKILL), [])).toBe(skillBody(SKILL));
    // The shared access code: no Vlastní soubory, no Zotero, UKAŽ as before.
    const result = await guide().handler({}, SHARED_CTX);
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toBe(tailorManual(skillBody(SKILL), ["files", "zotero"]));
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

describe("the manual is fitted to what the caller can use", () => {
  const body = skillBody(SKILL);

  it("every gated section's heading is in SKILL.md (a renamed heading must fail here, not silently stay in)", () => {
    for (const { heading } of Object.values(GATED_SECTIONS)) expect(body).toContain(`\n${heading}`);
  });

  it("drops exactly the named sections, keeps their neighbours, and says so under the title", () => {
    const text = tailorManual(body, ["files", "zotero", "ukaz"]);
    for (const { heading } of Object.values(GATED_SECTIONS)) expect(text).not.toContain(heading);
    for (const kept of ["## SDEU (InfoCuria)", "## Reading: screen, locate, then read whole", "## The memo"]) expect(text).toContain(kept);
    expect(text).toMatch(/^# Rešerše přes Dawmain\n\n> \*\*Not available on this connection: Vlastní soubory \(files_\*\), Zotero \(zotero_\*\), doktrína — UKAŽ \(doctrine_\*\)\.\*\*/);
    expect(text).toContain("Do not call these tools in this conversation");
    expect(text).toContain("no „Další zdroje“ literature section");
    // A quarter of the manual: what an account with none of the three no longer reads.
    expect(body.length - text.length).toBeGreaterThan(12_000);

    const filesOnly = tailorManual(body, ["files"]);
    expect(filesOnly).not.toContain(GATED_SECTIONS.files.heading);
    expect(filesOnly).toContain(GATED_SECTIONS.zotero.heading);
    expect(filesOnly).toContain(GATED_SECTIONS.ukaz.heading);
    expect(filesOnly).not.toContain("Další zdroje“ literature section");
  });

  it("a heading that is missing leaves the text alone and still adds the note", () => {
    const text = tailorManual("# T\n\nintro\n\n## A\n\na\n\n## Zotero (zotero_*): x\n\nz\n\n## B\n\nb", ["files", "zotero"]);
    expect(text).toBe(
      "# T\n\n> **Not available on this connection: Vlastní soubory (files_*), Zotero (zotero_*).** Their sections are left out of this manual. Do not call these tools in this conversation and skip every step below that names them — the first round is the official sources only. If the user asks for one of them, say it is switched on per account on the Dawmain website.\n\nintro\n\n## A\n\na\n\n## B\n\nb",
    );
  });

  const everythingConfigured = () => {
    process.env.FILES_MODE = "on";
    process.env.FILES_DATABASE_URL = "postgres://x";
    for (const name of ZOTERO_ENV) process.env[name] = name.startsWith("NEXT_PUBLIC") ? "pk_test_x" : "x".repeat(64);
  };

  it("no signed-in user: Vlastní soubory and Zotero off, UKAŽ kept — and Clerk is not asked", async () => {
    everythingConfigured();
    let asked = 0;
    __setAccessLoaderForTests(async () => (asked++, FULL));
    expect(await unavailableSources(SHARED_CTX)).toEqual(["files", "zotero"]);
    expect(await unavailableSources(undefined)).toEqual(["files", "zotero"]);
    expect(asked).toBe(0);
  });

  it("a signed-in account gets what its access says", async () => {
    everythingConfigured();
    __setAccessLoaderForTests(async () => FULL);
    expect(await unavailableSources(USER_CTX)).toEqual([]);
    __setAccessLoaderForTests(async () => emptyAccess(USER));
    expect(await unavailableSources(USER_CTX)).toEqual(["files", "zotero", "ukaz"]);
    __setAccessLoaderForTests(async () => ({ ...FULL, zotero: false }));
    expect(await unavailableSources(USER_CTX)).toEqual(["zotero"]);
    __setAccessLoaderForTests(async () => ({ ...FULL, banned: true }));
    expect(await unavailableSources(USER_CTX)).toEqual(["files", "zotero", "ukaz"]);
  });

  it("a deployment without Vlastní soubory or Zotero leaves them out even for Pro", async () => {
    __setAccessLoaderForTests(async () => FULL);
    process.env.FILES_MODE = "off";
    expect(await unavailableSources(USER_CTX)).toEqual(["files", "zotero"]);
  });

  it("a Clerk failure leaves nothing out that depends on the account", async () => {
    everythingConfigured();
    __setAccessLoaderForTests(async () => {
      throw new Error("Clerk down");
    });
    expect(await unavailableSources(USER_CTX)).toEqual([]);
  });

  it("the tool answers a signed-in account without Pro with the short manual", async () => {
    __setAccessLoaderForTests(async () => emptyAccess(USER));
    const text = (await guide().handler({}, USER_CTX)).content[0].text;
    expect(text).toBe(tailorManual(body, ["files", "zotero", "ukaz"]));
    expect(text.length).toBeLessThan(body.length * 0.8);
  });
});
