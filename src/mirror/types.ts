/**
 * The base record of one decision as every source maps it (v1-plan: ZÁKLAD).
 * Only these fields are stored; everything else is derived from `text`.
 */

export type MirrorSource = "ns" | "nss" | "us" | "justice" | "sdeu";

export const MIRROR_SOURCES: readonly MirrorSource[] = ["us", "ns", "nss", "justice", "sdeu"];

/** One vocabulary for the form of a decision across sources. */
export type DecisionType = "rozsudek" | "usneseni" | "nalez" | "stanovisko" | "jine";

/** "Nález", "USNESENÍ", "rozsudek" … → DecisionType; null when the source gives none. Pure. */
export function decisionType(raw: string | null | undefined): DecisionType | null {
  const folded = raw?.normalize("NFD").replace(/\p{M}/gu, "").trim().toLowerCase();
  if (!folded) return null;
  if (folded.startsWith("rozsud")) return "rozsudek";
  if (folded.startsWith("usnes")) return "usneseni";
  if (folded.startsWith("nalez")) return "nalez";
  if (folded.startsWith("stanovis")) return "stanovisko";
  return "jine";
}

/** A picture embedded in the decision, at an offset into the text. */
export interface DecisionImage {
  charAt: number;
  mime: "image/png" | "image/jpeg" | "image/gif" | "image/x-wmf" | "image/x-emf";
  width: number | null;
  height: number | null;
  bytes: Uint8Array;
  /** Where a separately fetched picture came from (NS: the Domino element URL). */
  sourceUrl?: string;
}

export interface DecisionRecord {
  source: MirrorSource;
  /** NS UNID, NSS numeric id, ÚS sz, justice UUID. */
  sourceId: string;
  url: string;
  court: string | null;
  caseNumber: string | null;
  caseNumbers: string[];
  decisionType: DecisionType | null;
  /** NS "Kategorie rozhodnutí" A–E; absent = none (or another source). */
  category?: string | null;
  /** Flags the source sets itself, verbatim (justice: specialType); absent = none. */
  sourceFlags?: string[];
  decidedOn: string | null; // ISO date
  legalSentence: string | null;
  ecli: string | null;
  publishedOn: string | null; // ISO date
  parserVersion: number;
  /** The full text and the path that produced it; null = not obtained (goes to fetch_queue). */
  text: { body: string; source: string } | null;
  /**
   * Why `text` is null when that is the source's state, not a failure (SDEU:
   * no Czech version exists) — stored without text and NOT queued for retry.
   */
  textAbsent?: string;
  /** Pictures of the decision; undefined = not read (a reindex from stored text leaves stored ones alone). */
  images?: DecisionImage[];
}
