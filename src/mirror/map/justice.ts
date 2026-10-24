import { decisionUrl, formatCaseNumber, type JusticeCaseNumber } from "@/src/sources/justice";
import type { DecisionRecord, DecisionType } from "../types";

/**
 * justice.cz (rozhodnuti.justice.cz, obecné soudy) → DecisionRecord. Identity
 * is the finaldoc UUID. The open-data day listing gives the court's name,
 * the č. j., ECLI and both dates; finaldoc gives the text (parseJusticeDecision:
 * záhlaví, výrok, odůvodnění, poučení — anonymization marks kept) and the
 * type. No pictures: the text comes as JSON paragraphs. Pure — unit-tested.
 */

export const JUSTICE_PARSER_VERSION = 1;

/** One item of /api/opendata/{y}/{m}/{d}, fields verbatim. */
export interface JusticeListItem {
  jednaciCislo?: string;
  soud?: string;
  ecli?: string;
  datumVydani?: string;
  datumZverejneni?: string;
  odkaz?: string;
}

const UUID_RE = /\/finaldoc\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

export function justiceUuid(item: JusticeListItem): string | null {
  return UUID_RE.exec(item.odkaz ?? "")?.[1]?.toLowerCase() ?? null;
}

/** DocTypeEnm → the mirror's vocabulary (ORDER_T is a trestní příkaz). */
export function justiceType(type: unknown): DecisionType | null {
  if (type === "JUDGEMENT") return "rozsudek";
  if (type === "RESOLUTION") return "usneseni";
  if (typeof type === "string" && type) return "jine";
  return null;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const iso = (v: unknown): string | null => (typeof v === "string" && ISO.test(v.slice(0, 10)) ? v.slice(0, 10) : null);

/** "9 C 311/2024-50" → ["9 C 311/2024", "9 C 311/2024-50"]: the sp. zn., then the č. j. */
export function justiceCaseNumbers(jednaciCislo: string | undefined, parts: JusticeCaseNumber | undefined): string[] {
  const cj = jednaciCislo?.replace(/\s+/g, " ").trim() || formatCaseNumber(parts);
  if (!cj) return [];
  const spzn = /^(.+?\/\d{4})-\d+$/.exec(cj)?.[1] ?? cj;
  return [...new Set([spzn, cj])];
}

export function mapJustice(
  uuid: string,
  item: JusticeListItem,
  decision: { text: string; metadata: Record<string, unknown> },
): DecisionRecord {
  const m = decision.metadata;
  const caseNumbers = justiceCaseNumbers(item.jednaciCislo, m.caseNumber as JusticeCaseNumber | undefined);
  return {
    source: "justice",
    sourceId: uuid,
    url: decisionUrl(uuid),
    court: item.soud?.trim() || (typeof m.courtCode === "string" ? m.courtCode : null),
    caseNumber: caseNumbers[0] ?? null,
    caseNumbers,
    decisionType: justiceType(m.type),
    sourceFlags: Array.isArray(m.specialType) ? m.specialType.filter((f): f is string => typeof f === "string" && f.length > 0) : [],
    decidedOn: iso(item.datumVydani) ?? iso(m.decisionAt),
    legalSentence: null,
    ecli: item.ecli?.trim() || (typeof m.ecli === "string" ? m.ecli : null),
    publishedOn: iso(item.datumZverejneni) ?? iso(m.publishedAt),
    parserVersion: JUSTICE_PARSER_VERSION,
    text: decision.text ? { body: decision.text, source: "justice:finaldoc" } : null,
    images: [],
  };
}
