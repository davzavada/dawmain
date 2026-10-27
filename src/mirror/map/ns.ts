import { czechToIso } from "@/src/sources/shared/text";
import { parseNsDecision, usToIso, type NsDecision } from "@/src/sources/ns";
import { decisionType, type DecisionImage, type DecisionRecord } from "../types";

/**
 * NS (rozhodnuti.nsoud.cz, Domino) → DecisionRecord. Identity is the UNID;
 * the base fields come from the decision page's metadata table (WebSearch,
 * WebPrint as the fallback rendition), the text from its body.
 *
 * Pictures: Domino serves the rich-text pictures of a decision (every one
 * carries the state emblem above "ČESKÁ REPUBLIKA") as separate GIF
 * elements. markNsPictures swaps each for a marker the text extraction
 * keeps; takeNsMarkers then gives each picture its offset in the final text
 * and removes the markers. A picture in the part parseNsDecision cuts (what
 * precedes the judgment's opening) lands at offset 0. Pure — unit-tested.
 */

/**
 * 2: WebSearch first (publication date), leading citation note cut.
 * 3: "Senátní značka" (insolvency: ICdo, NSČR) read as the case number.
 */
export const NS_PARSER_VERSION = 3;

const BASE = "https://rozhodnuti.nsoud.cz";
const MARK_OPEN = "";
const MARK_CLOSE = "";

export interface NsPictureRef {
  url: string;
  width: number | null;
  height: number | null;
}

/** A picture of the decision's own content: a Domino element of the database, not a UI icon. */
function isContentPicture(src: string): boolean {
  return /\.nsf\/.+(?:\?OpenElement|\/\$FILE\/)/i.test(src) && !/\/icons\//i.test(src);
}

/** Replace each content <img> with a text marker; returns the pictures in order. */
export function markNsPictures(html: string): { html: string; pictures: NsPictureRef[] } {
  const pictures: NsPictureRef[] = [];
  const marked = html.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = /\bsrc\s*=\s*"([^"]+)"/i.exec(tag)?.[1] ?? /\bsrc\s*=\s*'([^']+)'/i.exec(tag)?.[1];
    if (!src || !isContentPicture(src)) return tag;
    const attr = (name: string) => Number(new RegExp(`\\b${name}\\s*=\\s*"?(\\d+)`, "i").exec(tag)?.[1]) || null;
    pictures.push({ url: new URL(src.replace(/&amp;/g, "&"), BASE).toString(), width: attr("width"), height: attr("height") });
    return ` ${MARK_OPEN}${pictures.length - 1}${MARK_CLOSE} `;
  });
  return { html: marked, pictures };
}

/** The text without markers, and the offset of each marked picture in it (0 when cut away). */
export function takeNsMarkers(text: string, count: number): { text: string; offsets: number[] } {
  const offsets = new Array<number>(count).fill(0);
  let out = "";
  let last = 0;
  for (const m of text.matchAll(new RegExp(`[ \\t]*${MARK_OPEN}(\\d+)${MARK_CLOSE}[ \\t]*`, "g"))) {
    out += text.slice(last, m.index);
    const n = Number(m[1]);
    if (n < count) offsets[n] = out.length;
    last = m.index + m[0].length;
  }
  out += text.slice(last);
  // Removing a marker can leave a blank line or a leading break behind.
  const trimmedStart = out.length - out.trimStart().length;
  const clean = out.trim();
  return { text: clean, offsets: offsets.map((o) => Math.min(Math.max(0, o - trimmedStart), clean.length)) };
}

/** Parse a marked WebPrint/WebSearch page: the decision and its pictures' offsets. */
export function parseNsMarked(markedHtml: string, unid: string, pictureCount: number): { decision: NsDecision; offsets: number[] } {
  const decision = parseNsDecision(markedHtml, unid);
  const { text, offsets } = takeNsMarkers(decision.text, pictureCount);
  return { decision: { ...decision, text }, offsets };
}

function isoDate(raw: string | undefined): string | null {
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return raw.includes("/") ? (usToIso(raw) ?? czechToIso(raw)) : (czechToIso(raw) ?? usToIso(raw));
}

/** "21 Cdo 1234/2019, 21 Cdo 1235/2019" → both. */
export function nsCaseNumbers(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(/[,;]/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

export function mapNs(
  unid: string,
  decision: NsDecision,
  textSource: "ns:webprint" | "ns:websearch",
  images: DecisionImage[],
): DecisionRecord {
  const m = decision.metadata;
  // Insolvency decisions label it "Senátní značka" (29 ICdo 3/2017, 29 NSČR 12/2022).
  const caseNumbers = nsCaseNumbers(m["Spisová značka"] ?? m["Senátní značka"]);
  return {
    source: "ns",
    sourceId: unid.toUpperCase(),
    url: decision.url,
    court: m["Soud"] ?? null,
    caseNumber: caseNumbers[0] ?? null,
    caseNumbers,
    decisionType: decisionType(m["Typ rozhodnutí"]),
    category: /^[A-E]$/.test(m["Kategorie rozhodnutí"]?.trim().toUpperCase() ?? "") ? m["Kategorie rozhodnutí"]!.trim().toUpperCase() : null,
    decidedOn: isoDate(m["Datum rozhodnutí"]),
    legalSentence: m["Právní věta"]?.trim() || null,
    ecli: m["ECLI"]?.trim() || null,
    publishedOn: isoDate(m["Zveřejněno na webu"]),
    parserVersion: NS_PARSER_VERSION,
    text: decision.text ? { body: decision.text, source: textSource } : null,
    images,
  };
}
