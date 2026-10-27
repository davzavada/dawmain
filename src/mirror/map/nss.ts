import { czechToIso } from "@/src/sources/shared/text";
import { decisionType, type DecisionRecord } from "../types";

/**
 * NSS (vyhledavac.nssoud.cz) → DecisionRecord. Identity is the numeric
 * document id. The database holds the krajské soudy (správní úseky) too, so
 * the court comes from "Soud (senát)": a senate of NSS reads "Nejvyšší
 * správní soud (tříčlenný senát NSS)", anything else is the court's own name.
 * The detail's "Právní věta" (pravnivetaanv) is a yes/no flag, not the
 * sentence — it is not stored as one. Pure — unit-tested.
 */

export const NSS_PARSER_VERSION = 1;

const BASE = "https://vyhledavac.nssoud.cz";

/** "20.08.2026" or "31.08.2026 21:49:33" → ISO date. */
function isoDate(raw: string | undefined): string | null {
  if (!raw) return null;
  return czechToIso(raw.trim().split(/\s+/)[0] ?? "");
}

/**
 * "1 As 59/2026-106; Pej 1445/2026" → ["1 As 59/2026", "1 As 59/2026-106",
 * "Pej 1445/2026"]: the sp. zn. first (the č. j. without its "-106" sheet
 * number), then the č. j. and any further marks as NSS gives them.
 */
export function nssCaseNumbers(raw: string | undefined): string[] {
  const parts = (raw ?? "")
    .split(";")
    .map((s) => s.replace(/\s+/g, " ").replace(/\s*-\s*(?=\d+$)/, "-").trim())
    .filter(Boolean);
  if (parts.length === 0) return [];
  const first = parts[0];
  const spzn = /^(.+?\/\d{4})-\d+$/.exec(first)?.[1] ?? first;
  return [...new Set([spzn, ...parts])];
}

export function nssCourt(senat: string | undefined): string | null {
  const value = senat?.replace(/\s+/g, " ").trim();
  if (!value) return null;
  return /\bNSS\b|Nejvyšší správní soud|rozšířený senát/i.test(value) ? `Nejvyšší správní soud (${value})` : value;
}

export function mapNss(id: string, metadata: Record<string, string>, text: { body: string; source: string } | null): DecisionRecord {
  const caseNumbers = nssCaseNumbers(metadata["Spisová značka"]);
  return {
    source: "nss",
    sourceId: id,
    url: `${BASE}/DokumentDetail/Index/${id}`,
    court: nssCourt(metadata["Soud (senát)"]),
    caseNumber: caseNumbers[0] ?? null,
    caseNumbers,
    decisionType: decisionType(metadata["Druh dokumentu"]),
    sourceMeta: metadata,
    decidedOn: isoDate(metadata["Datum vydání rozhodnutí"]),
    legalSentence: null,
    ecli: metadata["ECLI"]?.trim() || null,
    publishedOn: isoDate(metadata["Datum zpřístupnění"]),
    parserVersion: NSS_PARSER_VERSION,
    text,
    images: [],
  };
}
