import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { getAccess } from "@/src/files/access";
import { envOnlyMode } from "@/src/files/guards";
import { zoteroConfigured } from "@/src/zotero/config";
import { callerFromCtx } from "../caller";

/**
 * The research manual, served by the connector itself (core first, source references on request — see TOPICS): the same
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
 * The source references of the manual: a section each, served apart as
 * `dawmain_guide {topics: [...]}`. They are field tables and operators of one
 * source — needed only once the model digs into that source, and half of the
 * manual. Serving them up front made the first answer ~16k tokens the model
 * read and weighed before its first search; the core alone is what every
 * research needs. Headings are pinned to SKILL.md in tests/guide.test.ts.
 */
export const TOPICS = {
  esbirka: { heading: "## e-Sbírka", label: "e-Sbírka — finding an act, its versions and wording" },
  psp: { heading: "## Poslanecká sněmovna", label: "sněmovní tisky, důvodová zpráva, the legislative process" },
  ns: { heading: "## Nejvyšší soud", label: "Nejvyšší soud — fields, categories and search operators" },
  nss: { heading: "## NSS: pole", label: "NSS — fields, the applied-provision citator, rozšířený senát, krajské soudy" },
  us: { heading: "## ÚS (NALUS)", label: "Ústavní soud — fields, nálezy, abstract review" },
  justice: { heading: "## Obecné soudy", label: "obecné soudy (rozhodnuti.justice.cz) — fields, court codes, appeals" },
  sdeu: { heading: "## SDEU (InfoCuria)", label: "SDEU — fields, languages, judgments vs opinions" },
  sk: { heading: "## Slovensko", label: "Slovak law (slov-lex.sk) — only when the user names Slovakia" },
} as const;
export type Topic = keyof typeof TOPICS;
const TOPIC_NAMES = Object.keys(TOPICS) as Topic[];

/** Where the `## ` section starting with `heading` runs in `text`: [start, end), or null. Pure. */
function sectionBounds(text: string, heading: string): [number, number] | null {
  const start = text.indexOf(`\n${heading}`);
  if (start < 0) return null;
  const next = text.indexOf("\n## ", start + 1);
  return [start, next < 0 ? text.length : next];
}

/**
 * The core manual: everything but the source references, with an index of
 * them where the first one stood. A heading that is not found is skipped.
 * Pure.
 */
export function coreManual(body: string): string {
  let text = body;
  let at = -1;
  for (const topic of TOPIC_NAMES) {
    const bounds = sectionBounds(text, TOPICS[topic].heading);
    if (!bounds) continue;
    if (at < 0 || bounds[0] < at) at = bounds[0];
    text = text.slice(0, bounds[0]) + text.slice(bounds[1]);
  }
  const index =
    "\n## Source references — dawmain_guide {topics: [...]}\n\n" +
    "Each source's fields, filters and operators are served apart, so this answer stays short. " +
    "Ask for the ones you need IN THE SAME TURN as your first in-depth search of that source (e.g. `dawmain_guide {topics: [\"ns\", \"justice\"]}` next to `ns_search` and `justice_search`) — never as a round of its own. " +
    "The tools' own descriptions carry their parameters too, so a first wide search needs none of these.\n\n" +
    TOPIC_NAMES.map((topic) => `- \`${topic}\` — ${TOPICS[topic].label}`).join("\n") +
    "\n";
  if (at < 0) return text;
  return text.slice(0, at) + index + text.slice(at);
}

/** The sections of `topics`, in the manual's order, each whole. Pure. */
export function topicSections(body: string, topics: Topic[]): string {
  const parts: string[] = [];
  for (const topic of TOPIC_NAMES) {
    if (!topics.includes(topic)) continue;
    const bounds = sectionBounds(body, TOPICS[topic].heading);
    if (bounds) parts.push(body.slice(bounds[0], bounds[1]).trim());
  }
  return parts.join("\n\n");
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
        "The research manual for this connector (the dawmain-reserse skill): how to write the brief, query craft in the courts' terms, the user's own sources (Vlastní soubory, Zotero, UKAŽ), how to screen, locate and read decisions whole, how to check a decision is still good law, when to stop, and the memo layout with its citation forms. Call it ONCE at the start of every legal research — whenever the user asks what the law, the courts or the doctrine say ('právní rešerše', 'rešerše k', 'co na to judikatura', 'najdi judikaturu k § X', 'jak to soudy vykládají', 'je na to nějaký rozsudek', 'platí ještě', 'co říká zákon o', 'najdi mi rozhodnutí', 'co na to doktrína', 'najdi důvodovou zprávu', 'co chtěl zákonodárce') or describes a legal problem expecting an answer grounded in statute, case law and literature, including everyday practical questions that name no statute ('je možné / lze / smím / musím…', 'je to platné' about a smlouva, podpis, výpověď, lhůta…), questions about Slovak law ('na Slovensku', 'slovenský zákon', 'Z. z.', 'NS SR', CZ/SK comparison) and EU transposition ('který zákon transponuje směrnici 2004/48') — in the SAME turn as your first searches, not as a step before them. Without arguments it returns the core manual; `topics` returns one source's field reference (esbirka, psp, ns, nss, us, justice, sdeu, sk — Slovak law only when the user names Slovakia) — ask for it in the same turn as your first in-depth search of that source; all returns the whole manual. Nothing needs to be installed.",
      inputSchema: z.object({
        topics: z
          .array(z.enum(["all", ...TOPIC_NAMES]))
          .optional()
          .describe("Source references to return instead of the core manual: esbirka, psp, ns, nss, us, justice, sdeu, sk; or \"all\" for the whole manual."),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args: unknown, ctx?: unknown) => {
      try {
        const asked = ((args as { topics?: string[] } | undefined)?.topics ?? []).filter(Boolean);
        const [body, off] = await Promise.all([loadSkill(), unavailableSources(ctx)]);
        const manual = tailorManual(body, off);
        if (asked.includes("all")) return { content: [{ type: "text" as const, text: manual }] };
        const topics = TOPIC_NAMES.filter((topic) => asked.includes(topic));
        const text = topics.length ? topicSections(manual, topics) : coreManual(manual);
        return { content: [{ type: "text" as const, text }] };
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
