import type { DecisionRecord, DecisionType } from "../types";

/**
 * SDEU (Cellar, Publications Office) → DecisionRecord. Identity is the CELEX
 * number; the record is in Czech (decided 25. 10. 2026: the mirror holds the
 * Czech version, another language is fetched live from Cellar). A document
 * without a Czech version is stored without text and with `textAbsent`.
 * Pure — unit-tested.
 */

export const SDEU_PARSER_VERSION = 1;

/** Case-law CELEX of a document itself (no _SUM/_INF companions): 62019CJ0311, 62019CO0853(01). */
export const SDEU_CELEX_RE = /^6(\d{4})(CJ|CC|CO|CS|CV|CP|CD|CX|CT|TJ|TO|TC|TT|FJ|FO|FT)(\d{4})(\(\d{2}\))?$/;

/** One row of the enumeration (SPARQL), fields as the query names them. */
export interface SdeuListItem {
  celex: string;
  ecli?: string;
  /** work_date_document — the date the decision was delivered. */
  date?: string;
  /** work_datetime_transmission — when the Publications Office received it. */
  published?: string;
  /** Czech expression: "Věc C-311/19", "Spojené věci C-…" — absent without a Czech version. */
  caseCs?: string;
  partiesCs?: string;
}

const COURT: Record<string, string> = { C: "Soudní dvůr", T: "Tribunál", F: "Soud pro veřejnou službu" };

export function sdeuCourt(celex: string): string | null {
  const kind = SDEU_CELEX_RE.exec(celex)?.[2];
  return kind ? (COURT[kind[0]] ?? null) : null;
}

/** CJ/TJ/FJ judgment, CO/TO/FO order, CC opinion of an Advocate General, the rest (CV, CP, CS…) other. */
export function sdeuType(celex: string): { type: DecisionType | null; flags: string[] } {
  const kind = SDEU_CELEX_RE.exec(celex)?.[2];
  if (!kind) return { type: null, flags: [] };
  const flags = [`CELEX:${kind}`];
  if (kind === "CC") return { type: "stanovisko", flags: [...flags, "GA"] };
  if (kind[1] === "J") return { type: "rozsudek", flags };
  if (kind[1] === "O") return { type: "usneseni", flags };
  return { type: "jine", flags };
}

/** The case number CELEX encodes: 62019CJ0311 → C-311/19 (court letter, number, registration year). */
export function celexCaseNumber(celex: string): string | null {
  const m = SDEU_CELEX_RE.exec(celex);
  if (!m) return null;
  return `${m[2][0]}-${Number(m[3])}/${m[1].slice(2)}`;
}

/** Every case number of the Czech identifier ("Spojené věci C-311/19 a C-312/19"), else the CELEX one. */
export function sdeuCaseNumbers(item: Pick<SdeuListItem, "celex" | "caseCs">): string[] {
  const named = [...(item.caseCs ?? "").matchAll(/\b([CTF])\s*[-‐–]\s*(\d{1,4})\s*\/\s*(\d{2})\b/g)].map((m) => `${m[1]}-${Number(m[2])}/${m[3]}`);
  const own = celexCaseNumber(item.celex);
  return [...new Set([...(own && named.includes(own) ? [own] : []), ...named, ...(own ? [own] : [])])];
}

const iso = (v: string | undefined): string | null => (v && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);

export function mapSdeu(item: SdeuListItem, textCs: string | null): DecisionRecord {
  const { type, flags } = sdeuType(item.celex);
  const caseNumbers = sdeuCaseNumbers(item);
  return {
    source: "sdeu",
    sourceId: item.celex,
    url: `https://eur-lex.europa.eu/legal-content/CS/TXT/?uri=CELEX:${encodeURIComponent(item.celex)}`,
    court: sdeuCourt(item.celex),
    caseNumber: caseNumbers[0] ?? null,
    caseNumbers,
    decisionType: type,
    sourceFlags: flags,
    decidedOn: iso(item.date),
    legalSentence: null,
    ecli: item.ecli?.trim() || null,
    publishedOn: iso(item.published),
    parserVersion: SDEU_PARSER_VERSION,
    text: textCs ? { body: textCs, source: "sdeu:cellar-ces" } : null,
    ...(textCs ? {} : { textAbsent: "česká verze v Cellaru neexistuje" }),
    images: [],
  };
}
