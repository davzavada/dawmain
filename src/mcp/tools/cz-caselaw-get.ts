import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { getNsDecision, nsBodyMissing, parseSpisovaZnacka, searchNs, withHighlight } from "@/src/sources/ns";
import { getNssDecision, searchNss } from "@/src/sources/nss";
import { ecliToSz, getNalusDecision, searchNalus } from "@/src/sources/nalus";
import { caseNumberToCelex, getCuriaDocument, searchCuria } from "@/src/sources/curia";
import { SourceError, asSourceError, toToolError } from "@/src/sources/shared/errors";
import { pageOrExcerpt } from "@/src/sources/shared/text";

/**
 * One-call lookup by spisová značka / case number / ECLI: work out WHICH
 * court the identifier belongs to, find the decision there and return its
 * text. Collapses the guess-the-court → search → get chain (2–3 model round
 * trips) into a single tool call for the most common request of all:
 * "najdi mi rozhodnutí sp. zn. X".
 *
 * Routing is a pure function (unit-tested). An identifier it cannot classify
 * falls back to asking NS and NSS in parallel — the two databases with an
 * exact case-number field whose marks are open-ended enough to be missing
 * from the lists below.
 */

export type LookupCourt = "ns" | "nss" | "nalus" | "curia";

export interface LookupTarget {
  court: LookupCourt;
  /** Case number for the court's exact search field (NS/NSS/CJEU, NALUS citace). */
  caseNumber?: string;
  /** NALUS-native sz (derived from an ECLI) — skips the search step entirely. */
  sz?: string;
  /** CJEU ECLI — fetched from Cellar directly, no search step. */
  ecli?: string;
}

const COURT_LABELS: Record<LookupCourt, string> = {
  ns: "Nejvyšší soud",
  nss: "Nejvyšší správní soud",
  nalus: "Ústavní soud",
  curia: "Soudní dvůr EU",
};

const DETAIL_TOOLS: Record<LookupCourt, string> = {
  ns: "ns_get_decision",
  nss: "nss_get_decision",
  nalus: "nalus_get_decision",
  curia: "curia_get_document",
};

/** Rejstříkové značky NS (folded to plain ASCII lowercase — "NSČR" → "nscr"). */
const NS_MARKS = new Set([
  "cdo", "icdo", "nscr", "odo", "odon", "tdo", "td", "tz", "tcu", "ncu", "nd", "cpjn", "tpjn",
]);

/** Rejstříkové značky NSS (vč. kárných a volebních senátů). */
const NSS_MARKS = new Set([
  "afs", "ads", "ans", "aos", "aprk", "aprn", "aps", "ars", "as", "azs",
  "komp", "konf", "kse", "kseo", "kss", "ksz", "na", "nad", "nao", "obn", "pst", "vol",
]);

function foldAscii(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function titleMark(mark: string): string {
  return mark.charAt(0).toUpperCase() + mark.slice(1).toLowerCase();
}

/**
 * ECLI:CZ:NS:2017:23.CDO.116.2017.1 → "23 Cdo 116/2017" — also the senate-less
 * marks (ECLI:CZ:NS:2015:CPJN.202.2015.1 → "Cpjn 202/2015") and NSS ECLIs,
 * whose trailing segment is the čj page number and is not part of the značka.
 * Pure — unit-tested.
 */
export function czEcliToCaseNumber(ecli: string): string | null {
  const m = /^ECLI:CZ:NSS?:\d{4}:(.+)$/i.exec(ecli.trim());
  if (!m) return null;
  const parts = m[1].split(".");
  if (parts.length >= 4 && /^\d+$/.test(parts[0])) {
    const [senate, mark, number, year] = parts;
    if (!/^\d{4}$/.test(year) || !/^\d+$/.test(number)) return null;
    return `${senate} ${titleMark(mark)} ${number}/${year}`;
  }
  if (parts.length >= 3) {
    const [mark, number, year] = parts;
    if (/^\d+$/.test(mark) || !/^\d+$/.test(number) || !/^\d{4}$/.test(year)) return null;
    return `${titleMark(mark)} ${number}/${year}`;
  }
  return null;
}

/** Classify a case identifier. null = unrecognized (the caller fans out). Pure — unit-tested. */
export function routeCaseIdentifier(raw: string): LookupTarget | null {
  const id = raw.trim();
  if (!id) return null;
  if (/^ECLI:/i.test(id)) {
    if (/^ECLI:CZ:US:/i.test(id)) {
      const sz = ecliToSz(id);
      return sz ? { court: "nalus", sz } : null;
    }
    // NSS before NS — the prefixes share "ECLI:CZ:NS".
    if (/^ECLI:CZ:NSS:/i.test(id)) {
      const caseNumber = czEcliToCaseNumber(id);
      return caseNumber ? { court: "nss", caseNumber } : null;
    }
    if (/^ECLI:CZ:NS:/i.test(id)) {
      const caseNumber = czEcliToCaseNumber(id);
      return caseNumber ? { court: "ns", caseNumber } : null;
    }
    if (/^ECLI:EU:/i.test(id)) return { court: "curia", ecli: id };
    return null;
  }
  if (/^[CTF]-\d{1,4}\/\d{2}$/i.test(id)) return { court: "curia", caseNumber: id.toUpperCase() };
  // Ústavní soud: "I. ÚS 1169/26", "Pl.ÚS 24/10", "Pl. ÚS-st. 27/09" — with or
  // without diacritics. The folded "us" token cannot collide with NSS's "As":
  // the match requires the literal letters u-s.
  if (/(^|[\s.])us(-st\.?)?\s*\.?\s*\d+\/\d{2,4}\b/.test(foldAscii(id))) {
    return { court: "nalus", caseNumber: id };
  }
  const parsed = parseSpisovaZnacka(id);
  if (parsed) {
    const mark = foldAscii(parsed.mark);
    if (NS_MARKS.has(mark)) return { court: "ns", caseNumber: id };
    if (NSS_MARKS.has(mark)) return { court: "nss", caseNumber: id };
  }
  return null;
}

interface Resolved {
  court: LookupCourt;
  /** Identifier for the court's own detail tool (unid / document id / sz / ecli|celex). */
  id: string;
  caseNumber: string;
  url: string;
  metadata?: Record<string, string>;
  text: string;
  /** Further decisions the same identifier matched (rare: opravná usnesení, ordinals). */
  others: Array<{ id: string; caseNumber: string; url: string | null }>;
}

async function resolveNs(caseNumber: string): Promise<Resolved | null> {
  const result = await searchNs({ caseNumber }, 0, 10);
  if (!result.hits.length) return null;
  const decision = await getNsDecision(result.hits[0].unid);
  return {
    court: "ns",
    id: decision.unid,
    caseNumber: result.hits[0].caseNumbers.join("; "),
    url: decision.url,
    metadata: decision.metadata,
    text: decision.text,
    others: result.hits.slice(1).map((hit) => ({
      id: hit.unid,
      caseNumber: hit.caseNumbers.join("; "),
      url: hit.url,
    })),
  };
}

async function resolveNss(caseNumber: string): Promise<Resolved | null> {
  const result = await searchNss({ caseNumber }, 1);
  if (!result.hits.length) return null;
  const decision = await getNssDecision(result.hits[0].id);
  return {
    court: "nss",
    id: decision.id,
    caseNumber: result.hits[0].caseNumber ?? caseNumber,
    url: decision.url,
    metadata: decision.metadata,
    text: decision.text,
    others: result.hits.slice(1).map((hit) => ({
      id: hit.id,
      caseNumber: hit.caseNumber ?? "?",
      url: hit.url,
    })),
  };
}

async function resolveNalus(target: LookupTarget): Promise<Resolved | null> {
  let sz = target.sz;
  let caseNumber = target.caseNumber ?? "";
  let others: Resolved["others"] = [];
  if (!sz) {
    const result = await searchNalus({ citace: target.caseNumber }, 0, 10);
    const hits = result.hits.filter((hit) => hit.sz);
    if (!hits.length) return null;
    sz = hits[0].sz as string;
    caseNumber = hits[0].caseNumber;
    others = hits.slice(1).map((hit) => ({
      id: hit.sz as string,
      caseNumber: hit.caseNumber,
      url: hit.url,
    }));
  }
  const decision = await getNalusDecision(sz);
  const metadata: Record<string, string> = {};
  if (decision.form) metadata["Forma rozhodnutí"] = decision.form;
  if (decision.popularName) metadata["Populární název"] = decision.popularName;
  if (decision.legalSentence) metadata["Právní věta"] = decision.legalSentence;
  return {
    court: "nalus",
    id: decision.sz,
    caseNumber: caseNumber || decision.sz,
    url: decision.url,
    metadata: Object.keys(metadata).length ? metadata : undefined,
    text: decision.text,
    others,
  };
}

async function resolveCuria(target: LookupTarget, language: string): Promise<Resolved | null> {
  if (target.ecli) {
    const document = await getCuriaDocument({ ecli: target.ecli, language });
    return {
      court: "curia",
      id: target.ecli,
      caseNumber: target.ecli,
      url: document.url,
      text: document.text,
      others: [],
    };
  }
  const caseNumber = target.caseNumber as string;
  const celex = caseNumberToCelex(caseNumber, "judgment");
  if (celex) {
    try {
      const document = await getCuriaDocument({ celex, language });
      return { court: "curia", id: celex, caseNumber, url: document.url, text: document.text, others: [] };
    } catch {
      // No judgment under the derived CELEX (pending case, order only) — the
      // InfoCuria search below finds whatever documents the case does have.
    }
  }
  const result = await searchCuria({ caseNumber }, 0, 10);
  const usable = result.hits.filter((hit) => hit.ecli || hit.logicDocId);
  if (!usable.length) return null;
  // Prefer the judgment; otherwise take whatever the case has (order, opinion).
  const best = usable.find((hit) => hit.docType?.startsWith("ARRET")) ?? usable[0];
  const id = (best.ecli || best.logicDocId) as string;
  const document = await getCuriaDocument(
    best.ecli ? { ecli: best.ecli, language } : { logicDocId: best.logicDocId, language },
  );
  return {
    court: "curia",
    id,
    caseNumber: best.caseNumber ?? caseNumber,
    url: document.url,
    text: document.text,
    others: usable
      .filter((hit) => hit !== best)
      .map((hit) => ({
        id: (hit.ecli || hit.logicDocId) as string,
        caseNumber: `${hit.caseNumber ?? caseNumber}${hit.docType ? ` [${hit.docType}]` : ""}`,
        url: hit.url,
      })),
  };
}

function resolveTarget(target: LookupTarget, language: string): Promise<Resolved | null> {
  switch (target.court) {
    case "ns":
      return resolveNs(target.caseNumber as string);
    case "nss":
      return resolveNss(target.caseNumber as string);
    case "nalus":
      return resolveNalus(target);
    case "curia":
      return resolveCuria(target, language);
  }
}

export function registerCzCaselawGet(server: McpServer): void {
  server.registerTool(
    "cz_caselaw_get",
    {
      title: "Case law: fetch one decision by case number / ECLI",
      description:
        "ONE-CALL lookup of a SPECIFIC decision the user already cites: pass the spisová značka, case number or ECLI and the server works out which court it belongs to (Nejvyšší soud, Nejvyšší správní soud, Ústavní soud, or the CJEU — '23 Cdo 116/2017' → NS, '1 Afs 25/2024' → NSS, 'Pl. ÚS 24/10' → ÚS, 'C-311/18' or an ECLI → the right database), finds it there and returns the full text directly — no separate search + get round trips. Prefer this over the *_search tools whenever a concrete decision is named; use cz_caselaw_search for topical research. Long texts come in ~45k-character pages. Token economy: to locate specific passages use 'find' (returns excerpts around matches); fetch further pages only when you genuinely need the whole text. Continue on your own — never ask the user whether to keep reading.",
      inputSchema: z.object({
        case_number: z
          .string()
          .optional()
          .describe(
            "Spisová značka / case number, e.g. '23 Cdo 116/2017', '1 Afs 25/2024-30', 'I. ÚS 1169/26', 'C-311/18'.",
          ),
        ecli: z
          .string()
          .optional()
          .describe("Alternative: an ECLI, e.g. 'ECLI:CZ:NS:2017:23.CDO.116.2017.1' or 'ECLI:EU:C:2020:559'."),
        court: z
          .enum(["ns", "nss", "nalus", "curia"])
          .optional()
          .describe("Force the court when the identifier alone is ambiguous (ns / nss / nalus = Ústavní soud / curia = CJEU)."),
        find: z
          .string()
          .optional()
          .describe(
            "Return only excerpts around matches of this term (diacritics-insensitive) instead of pages — the cheap way to locate specific passages in a long text.",
          ),
        page: z.number().int().min(1).default(1),
        language: z
          .string()
          .default("cs")
          .describe("CJEU documents only: preferred language version (falls back to English)."),
      }),
      outputSchema: z.object({
        court: z.enum(["ns", "nss", "nalus", "curia"]),
        court_label: z.string(),
        case_number: z.string(),
        id: z.string().describe("Identifier for the court's own detail tool."),
        detail_tool: z.string(),
        url: z.string(),
        metadata: z.record(z.string(), z.string()).optional(),
        page: z.number(),
        total_pages: z.number(),
        has_more: z.boolean(),
        matches: z.number().optional().describe("Match count when 'find' was used."),
        text: z.string(),
        also_matched: z.array(
          z.object({ id: z.string(), caseNumber: z.string(), url: z.string().nullable() }),
        ),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ case_number, ecli, court, find, page, language }) => {
      const identifier = (case_number ?? ecli ?? "").trim();
      if (!identifier) {
        return {
          content: [{ type: "text", text: "Pass 'case_number' (sp. zn.) or 'ecli'." }],
          isError: true,
        };
      }
      try {
        const routed = routeCaseIdentifier(identifier);
        let target = routed;
        if (court && routed?.court !== court) {
          // Explicit court wins over (or substitutes for) the pattern routing.
          if (court === "curia") {
            target = /^ECLI:/i.test(identifier)
              ? { court, ecli: identifier }
              : { court, caseNumber: identifier };
          } else if (court === "nalus" && /^ECLI:/i.test(identifier)) {
            const sz = ecliToSz(identifier);
            if (!sz) {
              throw new SourceError(
                COURT_LABELS[court],
                "INPUT_INVALID",
                `"${identifier}" is not an Ústavní soud ECLI.`,
                "Pass the spisová značka (e.g. 'I. ÚS 1169/26') or an ECLI:CZ:US:… identifier.",
              );
            }
            target = { court, sz };
          } else {
            target = {
              court,
              caseNumber: /^ECLI:/i.test(identifier)
                ? (czEcliToCaseNumber(identifier) ?? identifier)
                : identifier,
            };
          }
        }

        let resolved: Resolved | null = null;
        let fannedOut = false;
        if (target) {
          resolved = await resolveTarget(target, language);
        } else {
          // Unrecognized mark — ask the two exact-field databases in parallel.
          fannedOut = true;
          const [ns, nss] = await Promise.allSettled([resolveNs(identifier), resolveNss(identifier)]);
          const found = [ns, nss]
            .filter(
              (settled): settled is PromiseFulfilledResult<Resolved> =>
                settled.status === "fulfilled" && settled.value !== null,
            )
            .map((settled) => settled.value);
          // Both courts answering the same značka is next to impossible; if it
          // happens, prefer the tighter match and SAY the other court matched.
          found.sort((a, b) => a.others.length - b.others.length);
          resolved = found[0] ?? null;
          if (found.length > 1) {
            resolved = {
              ...found[0],
              others: [
                ...found[0].others,
                ...found[1].others,
                { id: found[1].id, caseNumber: `${found[1].caseNumber} (${COURT_LABELS[found[1].court]}!)`, url: found[1].url },
              ],
            };
          }
        }

        if (!resolved) {
          const label = target ? COURT_LABELS[target.court] : "žádný soud";
          throw new SourceError(
            target ? COURT_LABELS[target.court] : "cz_caselaw_get",
            "NOT_FOUND",
            `No decision matched '${identifier}'${target ? ` at ${label}` : fannedOut ? " at NS or NSS" : ""}.`,
            "Check the spisová značka for typos, pass 'court' explicitly, or search: ns_search / nss_search / nalus_search {case_number}, curia_search — or full-text cz_caselaw_search when only the topic is known.",
          );
        }

        const paged = pageOrExcerpt(resolved.text, page, find);
        const url = resolved.court === "ns" && find ? withHighlight(resolved.url, [find]) : resolved.url;
        const detailTool = DETAIL_TOOLS[resolved.court];
        const output = {
          court: resolved.court,
          court_label: COURT_LABELS[resolved.court],
          case_number: resolved.caseNumber,
          id: resolved.id,
          detail_tool: detailTool,
          url,
          metadata: resolved.metadata,
          page: paged.page,
          total_pages: paged.total_pages,
          has_more: paged.has_more,
          matches: paged.matches,
          text: paged.text,
          also_matched: resolved.others,
        };
        const meta = resolved.metadata
          ? Object.entries(resolved.metadata)
              .map(([key, value]) => `${key}: ${value}`)
              .join("\n")
          : "";
        const othersNote = resolved.others.length
          ? `\nAlso matched (fetch via ${detailTool} or cz_caselaw_get): ${resolved.others
              .map((other) => `${other.caseNumber} — id ${other.id}`)
              .join("; ")}`
          : "";
        const body =
          resolved.court === "ns" && nsBodyMissing(resolved.text)
            ? `(NS did not publish a machine-readable judgment body for this document — only metadata is available; open ${url} in a browser to check for an attached PDF.)`
            : `${paged.text}${
                paged.has_more
                  ? `\n\n(page ${paged.page}/${paged.total_pages} — fetch ONLY what you need, without asking the user: full close reading → call again with page: ${paged.page + 1}; specific passages → call again with find: "term" for targeted excerpts instead of more pages)`
                  : ""
              }`;
        const text = [
          `${COURT_LABELS[resolved.court]} — ${resolved.caseNumber}`,
          `${url}${othersNote}`,
          "",
          ...(meta ? [meta, ""] : []),
          body,
        ].join("\n");
        return { content: [{ type: "text", text }], structuredContent: output };
      } catch (error) {
        return toToolError(error instanceof SourceError ? error : asSourceError("cz_caselaw_get", error));
      }
    },
  );
}
