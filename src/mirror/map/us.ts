import { canonicalCaseNumber } from "@/src/files/index/identifiers";
import { htmlToText, loadHtml } from "@/src/sources/shared/html";
import { czechToIso } from "@/src/sources/shared/text";
import { extractRtfPictures, nalusEcli, type NalusAbstract, type NalusDecision, type NalusHit } from "@/src/sources/nalus";
import { decisionType, type DecisionImage, type DecisionRecord } from "../types";

/**
 * ÚS (NALUS) → DecisionRecord. Identity is the sz ("1-3338-23_1"); the
 * metadata comes from the results row (case number, ECLI, decision date,
 * date of publication), the text from GetText.aspx and the právní věta from
 * GetAbstract.aspx. Pure — unit-tested against fixtures.
 */

/**
 * Bump when the mapping changes what it stores: a backfill re-fetches rows
 * of an older version. 2: RTF pictures out of the text and into
 * decision_image, decision_type.
 */
export const US_PARSER_VERSION = 2;

/** A results row as the crawler needs it: parseNalusResults' hit + the date of publication. */
export interface UsHit extends NalusHit {
  sz: string;
  publishedOn?: string;
}

/**
 * Datum zpřístupnění per sz from a Results.aspx page. parseNalusResults does
 * not read it (the MCP tools have no use for it); the row's date cell stacks
 * "<b>rozhodnutí</b><br/>(vyhlášení)<br/>podání<br/>zpřístupnění", the
 * header row says so in the same order. Pure.
 */
export function parseUsPublishedDates(html: string): Map<string, string> {
  const $ = loadHtml(html);
  const out = new Map<string, string>();
  $("a[href^='ResultDetail.aspx']").each((_, el) => {
    const $row = $(el).closest("tr");
    const handlers = $row
      .next("tr")
      .find("[onclick]")
      .map((_, node) => $(node).attr("onclick") ?? "")
      .get()
      .join("\n");
    const sz = /GetText\.aspx\?sz=([^"&\s]+)/.exec(handlers)?.[1];
    const dateCell = $row.children("td").filter((_, td) => $(td).find("b").length > 0).first();
    const lines = htmlToText(dateCell.html() ?? "").split("\n").map((l) => l.trim());
    const published = lines[3] ? czechToIso(lines[3]) : null;
    if (sz && published) out.set(sz, published);
  });
  return out;
}

/** "Ústavní soud – plénum" / "– I. senát" from the sz registry. */
export function usCourt(sz: string): string {
  const registry = sz.split("-")[0];
  if (registry === "Pl") return "Ústavní soud – plénum";
  if (registry === "St") return "Ústavní soud – plénum (stanovisko)";
  const roman = ["I", "II", "III", "IV"][Number(registry) - 1];
  return roman ? `Ústavní soud – ${roman}. senát` : "Ústavní soud";
}

/** "I.ÚS 3338/23 #1" → "I. ÚS 3338/23" (canonical display), else the raw number without "#n". */
export function usCaseNumber(raw: string): string {
  const bare = raw.replace(/\s*#\d+\s*$/, "").trim();
  return canonicalCaseNumber(bare)?.display ?? bare;
}

/** What GetText.aspx gives besides parseNalusDecision: which path gave the text, and its pictures. */
export interface UsTextExtras {
  textSource: string;
  images: DecisionImage[];
}

/**
 * The hidden RTF input (the text parseNalusDecision reads first) carries the
 * pictures too; the rendered cell (fallback) has none we could take. Pure.
 */
export function usTextExtras(getTextHtml: string): UsTextExtras {
  const hidden = loadHtml(getTextHtml)("input#docContentHidden").attr("value");
  if (!hidden) return { textSource: "us:gettext-doccontent", images: [] };
  const images = extractRtfPictures(hidden).map(
    (p): DecisionImage => ({ charAt: p.offset, mime: p.mime, width: p.width ?? null, height: p.height ?? null, bytes: p.data }),
  );
  return { textSource: "us:gettext-hidden", images };
}

export function mapUs(hit: UsHit, decision: NalusDecision, abstract: NalusAbstract | null, extras: UsTextExtras): DecisionRecord {
  // Without a results row (a retry from fetch_queue of a decision never
  // stored), the page's own registry sign gives both: "I.ÚS 3338/23 ze dne 28. 3. 2024".
  const sign = decision.registrySign ? /^(.+?)\s+ze dne\s+(.+)$/.exec(decision.registrySign) : null;
  const caseNumber = usCaseNumber(hit.caseNumber || sign?.[1] || "");
  return {
    source: "us",
    sourceId: hit.sz,
    url: decision.url,
    court: usCourt(hit.sz),
    caseNumber: caseNumber || null,
    caseNumbers: caseNumber ? [caseNumber] : [],
    decisionType: decisionType(hit.form ?? decision.form),
    // The results row (soudce zpravodaj, form, SbNU citation); a retry has none and keeps what is stored.
    sourceMeta: hit.caseNumber ? { ...hit, registrySign: decision.registrySign ?? null } : null,
    decidedOn: hit.date ?? (sign ? czechToIso(sign[2]) : null),
    legalSentence: abstract?.legalSentence ?? null,
    ecli: hit.ecli ?? nalusEcli(hit.sz, decision.registrySign) ?? null,
    publishedOn: hit.publishedOn ?? null,
    parserVersion: US_PARSER_VERSION,
    text: decision.text ? { body: decision.text, source: extras.textSource } : null,
    images: decision.text ? extras.images.map((img) => ({ ...img, charAt: Math.min(img.charAt, decision.text.length) })) : [],
  };
}
