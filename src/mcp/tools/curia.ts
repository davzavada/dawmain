import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  FIND_DESCRIPTION,
  READING_DESCRIPTION,
  READ_ONLY,
  assertDateRange,
  continuationHint,
  isoDate,
  readTopSchema,
  toolFailure,
} from "./shared";
import {
  type CuriaAffair,
  type CuriaHit,
  bestCuriaDocument,
  caseNumberToCelex,
  curiaDocKind,
  getCuriaDocument,
  mergeCuriaAffairs,
  orderCuriaDocuments,
  searchCuria,
} from "@/src/sources/curia";
import { SourceError } from "@/src/sources/shared/errors";
import { maxTotal, pageOrExcerpt, uniqueQueries } from "@/src/sources/shared/text";
import { buildPreviews, noTermsNote, renderPreviews } from "./previews";
import { failureLines, runVariants, variantFailureSchema, variantTotalsSchema } from "./variants";

const fail = toolFailure("CJEU (InfoCuria)");

/** Merged variants read each variant's top (page+1)·limit cases in one
 * request (the backend honours pageSize far beyond this — up to 1000 seen
 * working, docs/research/eu-ip-sources.json); past this many the request
 * only grows — deep paging is for a single query, which reads exactly one
 * upstream page. */
export const MULTI_PREFIX_CAP = 100;
/** Documents listed per case on a page of several cases (decisions first);
 * the rest are named by type with the call that lists them all. A case has
 * up to ~7 matching documents (notices, summary, opinion, judgment), and 20
 * cases × 7 full lines would swamp the answer. */
export const DOCS_PER_CASE = 3;

export function registerCuria(server: McpServer): void {
  server.registerTool(
    "sdeu_search",
    {
      title: "CJEU: search case law",
      description:
        "FULL-TEXT search of CJEU case law (Court of Justice 'C', General Court 'T') via the court's own live InfoCuria index — the advanced-search surface: text of judgments/opinions + metadata, case number (C-311/18), case/party name, ECLI, case status (closed/pending), document type, court and date filters, relevance/date sort. Results come by CASE: each numbered case lists its matching documents (judgment, AG opinion, OJ notices, summary…) with their ids. The text search matches EVERY language version at once — Czech phrases work directly. Two filters work even without keywords: cites_celex (+cites_article) finds decisions citing a given act or article in their grounds, and referred_from lists preliminary rulings referred by a given member state's courts (e.g. ['CZ']). Includes same-day decisions. 'queries' searches up to 3 variants IN PARALLEL and merges them round-robin by case, so every variant is represented ('variant_totals' says what each found; a failed variant is named in 'failed_variants'); read_top: N also returns excerpt previews of the N leading cases (each case's judgment, else its best document). Fetch texts with sdeu_get_document.",
      inputSchema: z.object({
        query: z.string().optional().describe("Keywords (any EU language; English works best)."),
        queries: z
          .array(z.string().min(2))
          .max(3)
          .optional()
          .describe("Up to 3 query variants searched in parallel and merged round-robin (synonyms, CS/EN terms)."),
        case_number: z.string().optional().describe("E.g. 'C-311/18' or 'T-655/17'."),
        ecli: z.string().optional().describe("E.g. 'ECLI:EU:C:2020:559'."),
        parties: z
          .string()
          .optional()
          .describe("Case/party name, e.g. 'Telia Finland' — matched through document full text."),
        court: z.enum(["C", "T"]).optional().describe("C = Court of Justice, T = General Court."),
        state: z
          .enum(["all", "closed", "pending"])
          .default("all")
          .describe("Case status of the main proceedings (InfoCuria 'Case status')."),
        doc_type: z
          .enum(["any", "judgment", "opinion", "avis", "order", "request"])
          .default("any")
          .describe(
            "Restrict document kinds: judgment (incl. extracts/information), opinion = AG opinions, avis = Opinions of the Court (e.g. on international agreements), order, request = preliminary-ruling requests.",
          ),
        referred_from: z
          .array(
            z.enum([
              "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "EL", "HU", "IE", "IT",
              "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE", "UK", "XB",
            ]),
          )
          .max(10)
          .optional()
          .describe(
            "Only preliminary rulings referred by courts of these states — e.g. ['CZ'] for Czech references. EL = Greece, UK = pre-Brexit references, XB = Benelux Court of Justice. Works alone (no query needed) — combine with sort: 'date' (newest cases) and date_from for the latest decisions.",
          ),
        cites_celex: z
          .string()
          .optional()
          .describe(
            "Only decisions citing this act in their grounds — CELEX number: directive 2004/48 = '32004L0048', GDPR = '32016R0679'. Works alone (no query needed); for the recent line combine with sort: 'date' (newest cases) and date_from.",
          ),
        cites_article: z.coerce
          .string()
          .optional()
          .describe("Narrow cites_celex to one article: '1', '17' or '17(2)'."),
        date_from: isoDate.optional().describe("Document date from (ISO)."),
        date_to: isoDate.optional().describe("Document date to (ISO)."),
        sort: z
          .enum(["relevance", "date"])
          .default("relevance")
          .describe(
            "date = newest CASES first by lodging date, not by decision date — for the most recent decisions also set date_from (document date).",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .default(10)
          .describe("Cases per page, each listed with its matching documents."),
        page: z.number().int().min(0).default(0),
        language: z.string().default("en").describe("UI language for the search (en, cs, …)."),
        read_top: readTopSchema,
      }),
      outputSchema: z.object({
        total: z.number().describe("Matching cases."),
        cases: z.number(),
        count: z.number().describe("Documents (or bare case listings) on this page."),
        page: z.number(),
        has_more: z.boolean(),
        items: z.array(
          z.object({
            caseNumber: z.string().optional(),
            parties: z.string().optional(),
            ecli: z.string().optional(),
            caseName: z.string().optional(),
            date: z.string().optional(),
            docType: z.string().optional(),
            stateCode: z.string().optional(),
            logicDocId: z.string().optional(),
            url: z.string().nullable(),
          }),
        ),
        variant_totals: variantTotalsSchema,
        failed_variants: variantFailureSchema,
        previews: z
          .array(
            z.object({
              id: z.string(),
              caseNumber: z.string(),
              matches: z.number(),
              excerpt: z.string(),
            }),
          )
          .optional(),
      }),
      annotations: READ_ONLY,
    },
    async ({ query, queries, case_number, ecli, parties, court, state, doc_type, referred_from, cites_celex, cites_article, date_from, date_to, sort, limit, page, language, read_top }) => {
      try {
        assertDateRange("CJEU (InfoCuria)", date_from, date_to);
        const variants = uniqueQueries(query, queries);
        const keyed: Array<string | undefined> = variants.length ? variants : [undefined];
        const inputFor = (variant: string | undefined) => ({
          query: variant,
          caseNumber: case_number,
          ecli,
          parties,
          court,
          state,
          docType: doc_type,
          referredFrom: referred_from,
          citesCelex: cites_celex,
          citesArticle: cites_article,
          dateFrom: date_from,
          dateTo: date_to,
          sort,
          language,
        });
        // InfoCuria pages by CASE (pageSize = cases, each with its matching
        // documents), so the case is the unit here too: a page is `limit`
        // cases with ALL their returned documents. Cutting the page to
        // `limit` documents hid every further case of the upstream page —
        // the next page starts at the next upstream page — and every
        // further document of a case. One variant: upstream page = our page.
        // Several: each variant's ranked prefix of (page+1)·limit cases in
        // ONE request (not one per earlier page — page 9 × 3 variants was 30
        // parallel POSTs), merged round-robin by case.
        const multi = keyed.length > 1;
        const prefix = (page + 1) * limit;
        if (multi && prefix > MULTI_PREFIX_CAP) {
          throw new SourceError(
            "CJEU (InfoCuria)",
            "INPUT_INVALID",
            `Merged variants page only through the first ${MULTI_PREFIX_CAP} cases (page ${page} at limit ${limit} needs ${prefix}).`,
            "Deep paging works with a single query — drop 'queries' (keep the best one), or narrow with court, doc_type or date_from/date_to.",
          );
        }
        const { values, failures } = await runVariants(keyed, (variant) =>
          multi ? searchCuria(inputFor(variant), 0, prefix) : searchCuria(inputFor(variant), page, limit),
        );
        const answered = values.filter((value): value is NonNullable<typeof value> => value !== null);
        const merged = multi ? mergeCuriaAffairs(answered.map((value) => value.affairs)) : (answered[0]?.affairs ?? []);
        const affairs = multi ? merged.slice(page * limit, prefix) : merged;
        const total = maxTotal(answered.map((value) => value.total)) ?? 0;
        // Single: documents hidden on this page. Multi: in the prefixes read.
        const filtered = answered.reduce((n, value) => n + value.filtered, 0);
        const has_more = multi
          ? merged.length > prefix || answered.some((value) => value.total > prefix)
          : (page + 1) * limit < total;
        const variantTotals = multi ? values.map((value) => (value ? value.total : null)) : undefined;
        const items = affairs.flatMap((affair) => orderCuriaDocuments(affair.docs));

        // Previews read the case's best document (its judgment, not the OJ
        // notice upstream happens to list first), with both ids: the blob by
        // logic_doc_id stands in when Cellar has no text under the ECLI.
        const previewTargets = affairs
          .slice(0, read_top)
          .map((affair) => ({ affair, best: bestCuriaDocument(affair.docs) }))
          .filter((entry): entry is { affair: CuriaAffair; best: CuriaHit } => entry.best !== undefined)
          .map(({ affair, best }) => ({
            id: best.ecli || best.logicDocId || "",
            caseNumber: affair.caseNumber ?? affair.caseName ?? "?",
            ecli: best.ecli,
            logicDocId: best.logicDocId,
          }));
        const previews = await buildPreviews(
          previewTargets,
          (target) => getCuriaDocument({ ecli: target.ecli, logicDocId: target.logicDocId, language }).then((d) => d.text),
          variants,
        );
        const output = {
          total,
          cases: affairs.length,
          count: items.length,
          page,
          has_more,
          items,
          ...(variantTotals ? { variant_totals: variantTotals } : {}),
          ...(failures.length ? { failed_variants: failures } : {}),
          previews: previews?.map(({ id, caseNumber, matches, excerpt }) => ({ id, caseNumber, matches, excerpt })),
        };

        // A page of many cases lists each case's leading documents and names
        // the rest; a page of one case (a case_number search) lists them all.
        const perCase = affairs.length > 1 ? DOCS_PER_CASE : Infinity;
        const lines = affairs.flatMap((affair, i) => {
          const docs = orderCuriaDocuments(affair.docs);
          const name = affair.caseName ?? docs.find((doc) => doc.parties)?.parties ?? "";
          const pending = affair.stateCode?.startsWith("ENC") ? " (pending)" : "";
          const head = `${page * limit + i + 1}. ${affair.caseNumber ?? "?"} ${name}${pending}`.trimEnd();
          const listed = docs.filter((doc) => doc.docType);
          if (!listed.length) return [head, ...(docs[0]?.url ? [`   ${docs[0].url}`] : [])];
          // The citable link goes with the decisions (and with the first
          // document of a case that has none); a notice or summary keeps its
          // ids — its link is one sdeu_get_document away — so a page of
          // 10 cases does not carry 30 long URLs.
          const decisions = new Set(["judgment", "order", "AG opinion", "Opinion of the Court"]);
          const shown = listed.slice(0, perCase).map((doc, j) => {
            const kind = curiaDocKind(doc.docType);
            const link = doc.url && (j === 0 || (kind && decisions.has(kind))) ? ` · ${doc.url}` : "";
            const ids = [doc.ecli ? `ecli: ${doc.ecli}` : "", doc.logicDocId ? `logic_doc_id: ${doc.logicDocId}` : ""].filter(Boolean);
            return `   - ${kind ? `${kind} ` : ""}[${doc.docType}]${doc.date ? ` ${doc.date}` : ""}${ids.length ? ` · ${ids.join(" · ")}` : ""}${link}`;
          });
          const rest = listed.slice(perCase);
          const more = rest.length
            ? [
                `   +${rest.length} more (${rest.map((doc) => doc.docType).join(", ")})${affair.caseNumber ? ` — all: sdeu_search {case_number: "${affair.caseNumber}"}` : ""}`,
              ]
            : [];
          return [head, ...shown, ...more];
        });
        const variantLine = variantTotals
          ? `Variants: ${keyed.map((v, i) => `"${v}" ${variantTotals[i] ?? "✗"}`).join(" · ")} (merged round-robin by case)`
          : null;
        const sortNote = sort === "date" ? " (sorted by case lodging date, newest case first — not by decision date)" : "";
        const filteredNote = filtered
          ? ` (${filtered} documents ${multi ? "in the cases read" : "on this page"} hidden by doc_type/state/date filters)`
          : "";
        const anyDocs = items.some((hit) => hit.docType);
        let body: string;
        if (affairs.length) {
          body = [
            ...(variantLine ? [variantLine] : []),
            `${total} matching cases${sortNote}, cases ${page * limit + 1}–${page * limit + affairs.length}${multi ? " (merged variants)" : ""}${filteredNote}:`,
            ...lines,
            anyDocs
              ? "Full text: sdeu_get_document {ecli} or {logic_doc_id} (the logic_doc_id also reaches OJ notices and documents not yet in Cellar)."
              : "Case listings carry no document ids — fetch a case's documents with sdeu_search {case_number}, then texts with sdeu_get_document.",
            ...(items.some((hit) => curiaDocKind(hit.docType) === "OJ notice")
              ? ["An OJ notice's date is its publication in the Official Journal, not a decision date."]
              : []),
            ...(has_more ? [`More cases: page ${page + 1}.`] : []),
            ...renderPreviews(previews, "sdeu_get_document"),
            ...noTermsNote(read_top, variants, "sdeu_get_document"),
          ].join("\n");
        } else if (
          total > 0 &&
          (multi ? !has_more && merged.length > 0 && merged.length <= page * limit : page * limit >= total)
        ) {
          // Past the end — not a query problem. With variants, nothing merged
          // at all is not "past the end" of anything: the filter or the
          // scoring emptied the cases read, which the branches below say.
          const known = multi ? merged.length : total;
          body = `Page ${page} is past the end — ${known} ${multi ? "cases merged from the variants" : "matching cases"}, pages 0–${Math.max(0, Math.ceil(known / limit) - 1)} at limit ${limit}.`;
        } else if (total > 0 && filtered > 0) {
          body = `All ${filtered} documents ${multi ? "in the cases read" : "on this page"} fall outside the doc_type/state/date filter${has_more ? ` — try page ${page + 1}, or loosen the filter.` : "; there are no further pages — loosen the filter."}`;
        } else if (total > 0) {
          body = `${total} cases matched but no document scored for this query — add keywords (query), a case_number or an ecli; party names alone need the full-text route (put the name in 'query' or 'parties').`;
        } else {
          body = "No CJEU documents matched. Try English keywords or the exact case number.";
        }
        const text = [...failureLines(failures), body].join("\n");
        return { content: [{ type: "text", text }], structuredContent: output };
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "sdeu_get_document",
    {
      title: "CJEU: document text",
      description:
        `Full text of a CJEU judgment, order or AG opinion (or any document sdeu_search lists). Identify it by CELEX (62018CJ0311), ECLI (ECLI:EU:C:2020:559), logic_doc_id from sdeu_search (also reaches OJ notices and documents not yet in Cellar), or case_number + doc_type (the CELEX is derived; an ecli or logic_doc_id given with it wins). ${READING_DESCRIPTION}`,
      inputSchema: z.object({
        celex: z.string().optional().describe("CELEX number, e.g. '62018CJ0311'."),
        ecli: z.string().optional().describe("E.g. 'ECLI:EU:C:2020:559'."),
        case_number: z.string().optional().describe("With doc_type, derives the CELEX. E.g. 'C-311/18', 'C-465/20 P'. Party names alone cannot identify a document — resolve them via sdeu_search first."),
        doc_type: z.enum(["judgment", "order", "opinion"]).default("judgment"),
        logic_doc_id: z.string().optional().describe("From sdeu_search (e.g. id_228677) — for any listed document, including ones not yet in Cellar."),
        language: z.string().default("en").describe("Preferred language (cs, en, …); falls back to English."),
        find: z.string().optional().describe(FIND_DESCRIPTION),
        page: z.number().int().min(1).default(1),
      }),
      outputSchema: z.object({
        url: z.string(),
        via: z.enum(["cellar", "infocuria-blob"]),
        language: z.string().describe("Language of the text served — English when the requested one has none."),
        page: z.number(),
        total_pages: z.number(),
        has_more: z.boolean(),
        matches: z.number().optional().describe("Match count when 'find' was used."),
        text: z.string(),
      }),
      annotations: READ_ONLY,
    },
    async ({ celex, ecli, case_number, doc_type, logic_doc_id, language, find, page }) => {
      try {
        let resolvedCelex = celex;
        // The derived CELEX is a guess from doc_type; an explicit ecli or
        // logic_doc_id names one document exactly and wins. Deriving it
        // anyway answered an AG opinion's ECLI + case number with the
        // judgment (verified live: ECLI:EU:C:2019:1145 + C-311/18 → 62018CJ0311).
        if (!resolvedCelex && case_number && !ecli && !logic_doc_id) {
          resolvedCelex = caseNumberToCelex(case_number, doc_type) ?? undefined;
          if (!resolvedCelex) {
            throw new SourceError(
              "CJEU (InfoCuria)",
              "INPUT_INVALID",
              `case_number '${case_number}' cannot be mapped to a CELEX.`,
              `Pass the ecli or logic_doc_id that sdeu_search {case_number: "${case_number}"} lists for the document (suffixes such as RENV, P(R) or DEP and Civil Service Tribunal F- cases have no derivable CELEX).`,
            );
          }
        }
        if (!resolvedCelex && !ecli && !logic_doc_id) {
          throw new SourceError(
            "CJEU (InfoCuria)",
            "INPUT_INVALID",
            "No usable identifier provided.",
            "Pass celex, ecli, case_number (+doc_type), or logic_doc_id from sdeu_search.",
          );
        }
        const document = await getCuriaDocument({
          celex: resolvedCelex,
          ecli,
          logicDocId: logic_doc_id,
          language,
        });
        const paged = pageOrExcerpt(document.text, page, find);
        const output = {
          url: document.url,
          via: document.via,
          language: document.language,
          page: paged.page,
          total_pages: paged.total_pages,
          has_more: paged.has_more,
          matches: paged.matches,
          text: paged.text,
        };
        // Said in the text: a memo quoting it must know the wording is not
        // the requested language version.
        const fallbackNote = document.fallback
          ? "\n(Cellar has no text of this document in the requested language — this is the English version.)"
          : "";
        return {
          content: [
            {
              type: "text",
              text: `${document.url} (via ${document.via})${fallbackNote}\n\n${paged.text}${continuationHint(paged)}`,
            },
          ],
          structuredContent: output,
        };
      } catch (error) {
        return fail(error);
      }
    },
  );
}
