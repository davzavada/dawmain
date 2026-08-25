import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";

/**
 * HTML helpers for the scraped sources. cheerio's parse5 engine parses the
 * malformed markup these sites emit (Domino <font> soup without <tbody>,
 * WebForms output) the same way a browser does — which is what the recorded
 * selectors from working scrapers were written against.
 */

export function loadHtml(html: string): CheerioAPI {
  return cheerio.load(html);
}

/** Decode a response body honouring the charset in Content-Type (NSS /Text is UTF-16). */
export async function decodeBody(response: Response, fallbackCharset = "utf-8"): Promise<string> {
  const buffer = await response.arrayBuffer();
  const contentType = response.headers.get("content-type") ?? "";
  const charsetMatch = /charset=([^;]+)/i.exec(contentType);
  let charset = (charsetMatch?.[1] ?? fallbackCharset).trim().toLowerCase();
  // UTF-16 responses usually carry a BOM; trust it over the header.
  const bytes = new Uint8Array(buffer.slice(0, 2));
  if (bytes.length === 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) charset = "utf-16le";
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) charset = "utf-16be";
  }
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return new TextDecoder("utf-8").decode(buffer);
  }
}

/** Strip tags and collapse whitespace, preserving paragraph breaks. */
export function htmlToText(html: string): string {
  const $ = cheerio.load(html);
  $("script, style, noscript").remove();
  // Block-level elements become line breaks so paragraphs survive.
  $("p, div, br, tr, li, h1, h2, h3, h4, h5, h6").each((_, el) => {
    $(el).append("\n");
  });
  const text = $.root().text();
  return text
    .replace(/ /g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Decode \uXXXX escapes found in inline <script> string literals (NSS currParams). */
export function decodeJsStringLiteral(value: string): string {
  return value.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}
