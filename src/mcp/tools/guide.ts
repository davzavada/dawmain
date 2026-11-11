import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { getAccess } from "@/src/files/access";
import { envOnlyMode } from "@/src/files/guards";
import { zoteroConfigured } from "@/src/zotero/config";
import { callerFromCtx } from "../caller";

/**
 * The research manual, served by the connector itself: the same
 * skills/dawmain-reserse/SKILL.md the home page offers for download, read
 * from the repository tree at call time (next.config.ts traces it into the
 * function; registration does no I/O). The server instructions tell the
 * model to call this once at the start of every legal research — so
 * nobody has to install the skill in claude.ai, and every conversation
 * reads the version that is deployed, never a stale upload.
 *
 * Fitted to the caller (tailorManual): the sections of the sources this
 * connection cannot use — Vlastní soubory, Zotero, UKAŽ — are left out and
 * a note at the top says not to call their tools. Most accounts have none
 * of the three, and the whole manual told them to call files_search,
 * zotero_search and doctrine_search in the first round of every research:
 * three calls that could only answer "not for this account", and a quarter
 * of the manual (~14 of ~57 thousand characters) read for nothing.
 *
 * In one answer: the body is English with Czech terms of art
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

/** The gated sources of the manual: the heading its section starts with, and what the note calls it. */
export const GATED_SECTIONS = {
  files: { heading: "## Vlastní soubory (files_*)", label: "Vlastní soubory (files_*)" },
  zotero: { heading: "## Zotero (zotero_*)", label: "Zotero (zotero_*)" },
  ukaz: { heading: "## Doktrína (literatura)", label: "doktrína — UKAŽ (doctrine_*)" },
} as const;
export type GatedSource = keyof typeof GATED_SECTIONS;

/**
 * The manual without the sections of the sources in `off`, and with a note
 * under its title naming them. A section runs from its `## ` heading to the
 * next one. A heading that is not found leaves the text as it is (the note
 * still goes in); tests/guide.test.ts pins the headings to SKILL.md. Pure.
 */
export function tailorManual(body: string, off: GatedSource[]): string {
  if (!off.length) return body;
  let text = body;
  for (const source of off) {
    const start = text.indexOf(`\n${GATED_SECTIONS[source].heading}`);
    if (start < 0) continue;
    const next = text.indexOf("\n## ", start + 1);
    text = text.slice(0, start) + (next < 0 ? "" : text.slice(next));
  }
  const names = off.map((source) => GATED_SECTIONS[source].label).join(", ");
  const note =
    `> **Not available on this connection: ${names}.** Their sections are left out of this manual. ` +
    "Do not call these tools in this conversation and skip every step below that names them — the first round is the official sources only" +
    (off.includes("ukaz") ? "; the memo then has no „Další zdroje“ literature section" : "") +
    ". If the user asks for one of them, say it is switched on per account on the Dawmain website.";
  const titleEnd = text.indexOf("\n");
  return titleEnd < 0 ? `${note}\n\n${text}` : `${text.slice(0, titleEnd)}\n\n${note}${text.slice(titleEnd)}`;
}

/**
 * Which gated sources the caller cannot use — by the same rules as the
 * tools' own gates (files: FILES_MODE, a personal sign-in, a Pro library;
 * zotero: the deployment offers it, a personal sign-in, Pro; UKAŽ: off for
 * a signed-in account until an admin switches it on, open to the shared
 * code and to local development). One Clerk lookup, cached for a minute
 * and shared with those gates. When it fails, nothing that depends on it
 * is left out: a manual too long is better than one missing a section the
 * caller needed.
 */
export async function unavailableSources(ctx: unknown): Promise<GatedSource[]> {
  const caller = callerFromCtx(ctx);
  const filesMode = envOnlyMode();
  const filesOff = filesMode === "off" || filesMode === "unconfigured";
  const zoteroOff = !zoteroConfigured();
  if (caller.kind !== "user") return ["files", "zotero"];
  try {
    const access = await getAccess(caller.userId);
    const off: GatedSource[] = [];
    if (filesOff || access.banned || !access.libraries.length) off.push("files");
    if (zoteroOff || access.banned || !access.zotero) off.push("zotero");
    if (access.banned || access.ukaz !== true) off.push("ukaz");
    return off;
  } catch {
    const off: GatedSource[] = [];
    if (filesOff) off.push("files");
    if (zoteroOff) off.push("zotero");
    return off;
  }
}

export function registerGuide(server: McpServer): void {
  server.registerTool(
    "dawmain_guide",
    {
      title: "Research manual",
      description:
        "The research manual for this connector (the dawmain-reserse skill), whole: how to write the brief, query craft in the courts' terms, each source's fields and filters (e-Sbírka, Poslanecká sněmovna, NS, NSS, ÚS, obecné soudy, SDEU, EUR-Lex, UKAŽ, Vlastní soubory, Zotero), how to screen, locate and read decisions whole, how to check a decision is still good law, when to stop, and the memo layout with its citation forms. Call it ONCE at the start of every legal research — whenever the user asks what the law, the courts or the doctrine say ('právní rešerše', 'rešerše k', 'co na to judikatura', 'najdi judikaturu k § X', 'jak to soudy vykládají', 'je na to nějaký rozsudek', 'platí ještě', 'co říká zákon o', 'najdi mi rozhodnutí', 'co na to doktrína', 'najdi důvodovou zprávu', 'co chtěl zákonodárce') or describes a legal problem expecting an answer grounded in statute, case law and literature, including everyday practical questions that name no statute ('je možné / lze / smím / musím…', 'je to platné' about a smlouva, podpis, výpověď, lhůta…) — before the first search. Takes no arguments; nothing needs to be installed.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (_args: unknown, ctx?: unknown) => {
      try {
        const [body, off] = await Promise.all([loadSkill(), unavailableSources(ctx)]);
        return { content: [{ type: "text" as const, text: tailorManual(body, off) }] };
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
