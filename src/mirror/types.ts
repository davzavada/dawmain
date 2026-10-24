/**
 * The base record of one decision as every source maps it (v1-plan: ZÁKLAD).
 * Only these fields are stored; everything else is derived from `text`.
 */

export type MirrorSource = "ns" | "nss" | "us" | "justice";

export const MIRROR_SOURCES: readonly MirrorSource[] = ["us", "ns", "nss", "justice"];

export interface DecisionRecord {
  source: MirrorSource;
  /** NS UNID, NSS numeric id, ÚS sz, justice UUID. */
  sourceId: string;
  url: string;
  court: string | null;
  caseNumber: string | null;
  caseNumbers: string[];
  decidedOn: string | null; // ISO date
  legalSentence: string | null;
  ecli: string | null;
  publishedOn: string | null; // ISO date
  parserVersion: number;
  /** The full text and the path that produced it; null = not obtained (goes to fetch_queue). */
  text: { body: string; source: string } | null;
}
