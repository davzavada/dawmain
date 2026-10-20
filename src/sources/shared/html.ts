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

/**
 * decodeBody for HTML whose server names no charset in Content-Type: the
 * document's own <meta charset> (or http-equiv Content-Type) decides, read
 * from the ASCII-safe head of the body. psp.cz pages are served that way in
 * windows-1250 as well as UTF-8, and a wrong guess turns every Czech
 * letter into mojibake the model would faithfully quote. A header charset
 * still wins; a body that declares nothing is UTF-8.
 */
export async function decodeHtmlBody(response: Response): Promise<string> {
  const contentType = response.headers.get("content-type") ?? "";
  if (/charset=/i.test(contentType)) return decodeBody(response);
  const buffer = await response.arrayBuffer();
  const head = new TextDecoder("latin1").decode(buffer.slice(0, 4096));
  const declared = metaCharset(head);
  if (declared) {
    try {
      return new TextDecoder(declared).decode(buffer);
    } catch {
      // An unknown label falls through to UTF-8.
    }
  }
  return new TextDecoder("utf-8").decode(buffer);
}

/** The charset an HTML head declares, lower-cased, or null. Pure. */
export function metaCharset(head: string): string | null {
  const m = /<meta[^>]+charset=["']?\s*([\w-]+)/i.exec(head);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Cheap "does this look like markup?" test. Deliberately bounded: the obvious
 * /<\w+[^>]*>/ backtracks quadratically on text full of "<" with no ">"
 * (measured: 15 s on 200 kB — a normal decision length), which would burn the
 * whole function budget on one malformed upstream body.
 */
export function looksLikeHtml(text: string): boolean {
  return /<[a-zA-Z][^>]{0,200}>/.test(text.slice(0, 100_000));
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
