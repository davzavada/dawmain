import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";

/**
 * The research manual, served by the connector itself: the same
 * skills/dawmain-reserse/SKILL.md the home page offers for download, read
 * from the repository tree at call time (next.config.ts traces it into the
 * function; registration does no I/O). The server instructions tell the
 * model to call this once at the start of every legal research — so
 * nobody has to install the skill in claude.ai, and every conversation
 * reads the version that is deployed, never a stale upload.
 *
 * Whole, in one answer: the body is English with Czech terms of art
 * (~3.5 characters per token), so even at SKILL_MAX_CHARS it stays under
 * the ~25k-token cap clients put on one tool result. tests/guide.test.ts
 * fails when the skill outgrows that bound, so the cap is noticed before a
 * client silently drops the answer.
 */

export const SKILL_PATH = path.join("skills", "dawmain-reserse", "SKILL.md");
/** Largest body served whole; past it the skill needs sections (a `topic` parameter), not a bigger answer. */
export const SKILL_MAX_CHARS = 80_000;
/** Where the same file is downloadable — the fallback named when the function cannot read it. */
export const SKILL_URL = "https://dawmain.davidzavada.cz/dawmain-reserse.md";

/** The skill's body without its YAML front matter (name and description are the installer's, not the reader's). Pure — unit-tested. */
export function skillBody(markdown: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(markdown);
  return (m ? markdown.slice(m[0].length) : markdown).trim();
}

let cached: Promise<string> | undefined;

/** The skill body, read once per warm instance (the file is immutable within a deployment). */
export function loadSkill(root = process.cwd()): Promise<string> {
  cached ??= fs.readFile(path.join(root, SKILL_PATH), "utf8").then(skillBody, (error: unknown) => {
    cached = undefined;
    throw error;
  });
  return cached;
}

/** Tests: forget the cached read. */
export function resetSkillCache(): void {
  cached = undefined;
}

export function registerGuide(server: McpServer): void {
  server.registerTool(
    "dawmain_guide",
    {
      title: "Research manual",
      description:
        "The research manual for this connector (the dawmain-reserse skill), whole: how to write the brief, query craft in the courts' terms, each source's fields and filters (e-Sbírka, Poslanecká sněmovna, NS, NSS, ÚS, obecné soudy, SDEU, EUR-Lex, UKAŽ, Vlastní soubory, Zotero), how to screen, locate and read decisions whole, how to check a decision is still good law, when to stop, and the memo layout with its citation forms. Call it ONCE at the start of every legal research — whenever the user asks what the law, the courts or the doctrine say ('právní rešerše', 'rešerše k', 'co na to judikatura', 'najdi judikaturu k § X', 'jak to soudy vykládají', 'je na to nějaký rozsudek', 'platí ještě', 'co říká zákon o', 'najdi mi rozhodnutí', 'co na to doktrína', 'najdi důvodovou zprávu', 'co chtěl zákonodárce') or describes a legal problem expecting an answer grounded in statute, case law and literature — before the first search. Takes no arguments; nothing needs to be installed.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        const body = await loadSkill();
        return { content: [{ type: "text" as const, text: body }] };
      } catch (error) {
        return {
          isError: true as const,
          content: [
            {
              type: "text" as const,
              text: `The research manual could not be read on this deployment (${error instanceof Error ? error.message : String(error)}). It is the same text as ${SKILL_URL} — proceed by the server instructions and the tools' own descriptions; run dawmain_probe_sources if other tools fail too.`,
            },
          ],
        };
      }
    },
  );
}
