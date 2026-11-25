import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { SourceError } from "@/src/sources/shared/errors";
import {
  getMirrorCitations,
  mirrorConfigured,
  mirrorDecisionsByCase,
  MIRROR_COURTS,
  MIRROR_SOURCE_LABEL,
  type MirrorCitations,
  type MirrorCourt,
  type MirrorLinkedDecision,
} from "@/src/sources/mirror";
import { citedByCourts, courtLabel, MIRROR_NOTE, readCall } from "./mirror-route";
import { READ_ONLY, toolFailure } from "./shared";

/**
 * caselaw_citations — the citator over the home mirror: who cites a decision
 * (later authority — counted by court, the courts that bind first, each with
 * the passage naming it) and what it cites itself. The links are
 * extracted from the texts at sync (src/mirror/citations.ts): a spisová
 * značka or ECLI a decision names, matched to the decisions carrying it.
 * Mirror only — the courts' own sites have no such lookup, so there is no
 * live fallback; without the mirror the tool says so.
 */

const FORM: Record<string, string> = {
  rozsudek: "rozsudek",
  usneseni: "usnesení",
  nalez: "nález",
  stanovisko: "stanovisko",
  jine: "jiné",
};

export const CITATIONS_MAX_LIMIT = 50;
/** Cited keys shown per call: a long judgment names a hundred, the first ones carry its argument. */
const CITES_SHOWN = 40;

function decisionLine(d: MirrorLinkedDecision): string {
  const facts = [d.form ? (FORM[d.form] ?? d.form) : null, d.date].filter(Boolean).join(", ");
  const court = courtLabel(d);
  return `[${d.source.toUpperCase()}] ${d.caseNumber ?? "?"}${facts ? ` (${facts})` : ""}${court ? ` — ${court}` : ""} → ${readCall(d.source, d.id)}`;
}

/** Characters of a citing decision's text shown around the citation. */
const CITING_CHARS = 300;

/** The citing passage in one line, cut at a word. Pure. */
function citingPassage(excerpt: string | undefined): string {
  const clean = excerpt?.replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const cut = clean.length > CITING_CHARS ? `${clean.slice(0, clean.lastIndexOf(" ", CITING_CHARS))}…` : clean;
  return `\n   …${cut}`;
}

export interface CitationsView {
  source: MirrorCourt;
  id: string;
  direction: "cited_by" | "cites" | "both";
  limit: number;
  offset: number;
  citedBySources?: MirrorCourt[];
}

/** "higher courts first" / "newest first" — the order the mirror answered in (an API that predates the choice: newest). */
function orderLabel(order: "newest" | "courts" | undefined): string {
  return order === "courts" ? "stanoviska, plénum and velký / rozšířený senát first, then nálezy, the top courts, the rest; newest within each" : "newest first";
}

/** The answer text. Pure — unit-tested. */
export function formatCitations(links: MirrorCitations, view: CitationsView): string {
  const lines: string[] = [MIRROR_NOTE, `Citation links of ${view.source.toUpperCase()} decision ${view.id} (${readCall(view.source, view.id)})`];

  if (view.direction !== "cites") {
    const { total, hits } = links.citedBy;
    // A značka shared with another court: the mirror links citations by značka, and cannot tell whose is meant.
    const same = links.sameCaseNumber;
    if (same?.total) {
      const named = same.decisions.map((d) => `${courtLabel(d) || d.source.toUpperCase()}${d.date ? ` ${d.date}` : ""}`).join("; ");
      lines.push(
        "",
        `⚠ ${same.total} decision${same.total === 1 ? "" : "s"} of another court ${same.total === 1 ? "carries" : "carry"} the same spisová značka (${named}${same.total > same.decisions.length ? "; …" : ""}): some of the citing decisions below may mean ${same.total === 1 ? "that one" : "those"} — the passage under each shows which court it names.`,
      );
    }
    const scope = view.citedBySources?.length ? ` from ${view.citedBySources.map((s) => s.toUpperCase()).join(", ")}` : "";
    lines.push("");
    if (!total) {
      lines.push(`Cited by: no mirrored decision${scope} names it.`);
    } else {
      const first = view.offset + 1;
      const last = view.offset + hits.length;
      const { bySource, top } = links.citedBy;
      const courts = bySource ? citedByCourts(bySource) : "";
      const topNote = typeof top === "number" ? (top ? `; ${top} of them a stanovisko, the plenum of the ÚS, a velký senát of the NS or a rozšířený senát of the NSS` : "; none of them a stanovisko, plenum, velký or rozšířený senát") : "";
      lines.push(`Cited by ${total} decision${total === 1 ? "" : "s"}${scope}${courts ? ` (${courts}${topNote})` : ""}.`);
      lines.push(`${hits.length ? `${first}–${last}` : "None on this page"} — ${orderLabel(links.citedBy.order)}; under each, its text where it first names the decision:`);
      hits.forEach((hit, i) => {
        lines.push(`${view.offset + i + 1}. ${decisionLine(hit)}${hit.mentions > 1 ? ` · names it ${hit.mentions}×` : ""}${citingPassage(hit.excerpt)}`);
      });
      if (last < total) lines.push(`More: offset: ${last} (same arguments).`);
    }
  }

  if (view.direction !== "cited_by") {
    lines.push("");
    if (!links.cites.length) {
      lines.push("Cites: no decision recognised in its text.");
    } else {
      const shown = links.cites.slice(0, CITES_SHOWN);
      lines.push(`Cites ${links.cites.length} decision${links.cites.length === 1 ? "" : "s"} — in the order the text names them${links.cites.length > shown.length ? `, first ${shown.length} shown` : ""}:`);
      shown.forEach((cited, i) => {
        const times = cited.mentions > 1 ? ` · ${cited.mentions}×` : "";
        if (!cited.decisions.length) {
          lines.push(`${i + 1}. ${cited.display}${times} — not in the mirror (a court it does not hold, or not published)`);
        } else if (cited.decisions.length === 1) {
          lines.push(`${i + 1}. ${cited.display}${times} — ${decisionLine(cited.decisions[0])}`);
        } else {
          lines.push(`${i + 1}. ${cited.display}${times} — ${cited.decisions.length} decisions carry this značka:`);
          for (const d of cited.decisions.slice(0, 5)) lines.push(`   · ${decisionLine(d)}`);
        }
      });
    }
  }

  lines.push(
    "",
    "A citing decision may follow, distinguish or overrule: the line under a hit is where it first names the decision, not its verdict on it — for one the answer turns on, read the passage (the *_get_* call with find: the cited spisová značka). The links cover the mirrored courts only (NS, NSS, ÚS, obecné soudy from 10/2020) and what the texts spell out — a missing link is not proof that nobody cites it.",
  );
  return lines.join("\n");
}

export function registerCitations(server: McpServer): void {
  server.registerTool(
    "caselaw_citations",
    {
      title: "Case law: who cites a decision, and what it cites",
      description:
        "The citator: for ONE Czech decision, the later decisions that cite it (NS, NSS, ÚS and obecné soudy — counted by court, the courts that bind first, each with the passage where it names the decision) and, on request, the decisions it cites itself. Use it to check a decision is still good law — whether a velký senát, a stanovisko or the Ústavní soud took it up, and how the lower courts apply it — and to walk a line of case law from its leading decision. Identify the decision by the court's own id from a search hit (source + id: NS unid, NSS document_id, ÚS sz, justice uuid) or by source + case_number. Links are read from the decision texts in the Dawmain mirror; each citing hit names the *_get_* call that reads it — open it with find: the cited spisová značka to see what it did with the decision.",
      inputSchema: z.object({
        source: z.enum(["ns", "nss", "us", "justice"]).describe("The court of the decision: ns, nss, us (Ústavní soud) or justice (okresní, krajské, vrchní soudy)."),
        id: z
          .string()
          .min(1)
          .max(80)
          .optional()
          .describe("The court's own id of the decision, as search hits give it: NS unid, NSS document_id, ÚS sz, justice uuid."),
        case_number: z
          .string()
          .min(3)
          .max(60)
          .optional()
          .describe("Spisová značka instead of id, e.g. '31 Cdo 1945/2010'. Several decisions under one značka come back as a list to choose from."),
        direction: z
          .enum(["cited_by", "cites", "both"])
          .default("cited_by")
          .describe("cited_by = who cites it (default); cites = what it cites; both."),
        cited_by_sources: z
          .array(z.enum(["ns", "nss", "us", "justice"]))
          .optional()
          .describe("Only citing decisions of these courts, e.g. ['us'] for what the Ústavní soud said about it. Default: all."),
        order: z
          .enum(["courts", "newest"])
          .default("courts")
          .describe("courts = stanoviska, plénum ÚS, velký senát NS and rozšířený senát NSS first, then nálezy, the top courts, obecné soudy (default); newest = by decision date alone."),
        limit: z.number().int().min(1).max(CITATIONS_MAX_LIMIT).default(20).describe("Citing decisions per page."),
        offset: z.number().int().min(0).max(100_000).default(0).describe("Skip this many citing decisions (pagination)."),
      }),
      annotations: READ_ONLY,
    },
    async ({ source, id, case_number, direction, cited_by_sources, order, limit, offset }) => {
      try {
        if (!mirrorConfigured()) {
          throw new SourceError(
            MIRROR_SOURCE_LABEL,
            "UPSTREAM_UNREACHABLE",
            "Citation links need the case-law mirror, which this deployment does not have.",
            "Search the citation as full text instead: ns_search / nss_search / us_search with the whole spisová značka as the query.",
          );
        }
        let decisionId = id?.trim();
        if (!decisionId) {
          if (!case_number?.trim()) {
            throw new SourceError(MIRROR_SOURCE_LABEL, "INPUT_INVALID", "Neither id nor case_number was given.", "Pass the id from a search hit, or the spisová značka as case_number.");
          }
          const found = await mirrorDecisionsByCase(case_number.trim(), [source]);
          if (!found.length) {
            return {
              content: [{ type: "text" as const, text: `${MIRROR_NOTE}\nNo ${source.toUpperCase()} decision with spisová značka "${case_number.trim()}" in the mirror. Check the court (source) and the značka, or find the decision with the court's search tool and pass its id.` }],
            };
          }
          if (found.length > 1) {
            const list = found.map((d, i) => `${i + 1}. ${decisionLine(d).replace(/ → .*$/, "")} → caselaw_citations source: ${d.source}, id: ${d.id}`);
            return {
              content: [{ type: "text" as const, text: [MIRROR_NOTE, `${found.length} decisions carry "${case_number.trim()}" — call again with the id of the one you mean:`, ...list].join("\n") }],
            };
          }
          decisionId = found[0].id;
        }
        const citedBySources = cited_by_sources?.length ? (cited_by_sources.filter((s) => MIRROR_COURTS.includes(s)) as MirrorCourt[]) : undefined;
        const links = await getMirrorCitations(source, decisionId, { limit, offset, citedBySources, order });
        if (!links) {
          return {
            content: [{ type: "text" as const, text: `${MIRROR_NOTE}\nThe mirror does not hold ${source.toUpperCase()} decision ${decisionId} (not published yet, or the id belongs to another court). Search the citation as full text instead: the court's *_search tool with the whole spisová značka as the query.` }],
          };
        }
        return { content: [{ type: "text" as const, text: formatCitations(links, { source, id: decisionId, direction, limit, offset, citedBySources }) }] };
      } catch (error) {
        return toolFailure(MIRROR_SOURCE_LABEL)(error);
      }
    },
  );
}
