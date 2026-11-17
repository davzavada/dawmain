/**
 * E-mail (.eml, RFC 5322 + MIME) → DMD, in the browser like every other
 * format: the message never leaves the device, only its text does.
 *
 * What is kept: the subject (as the heading), who wrote it, to whom, when,
 * the names of the attachments, and the body — the text/plain part when
 * the message has one, otherwise the text/html part without scripts,
 * styles and images. Attachments themselves are NOT converted (the user
 * uploads them as files of their own); nothing else of the headers
 * (routing, message ids, client names) is kept.
 *
 * The message is first turned into the simple HTML mammoth writes for a
 * DOCX and goes through that converter's walker (`htmlToDmd`), so escaping
 * and the limits are the ones already tested there.
 *
 * `parseEmail` and `emailToHtml` are pure — unit-tested in
 * tests/files-convert-email.test.ts.
 */

import type { ConversionQuality } from "../types";
import { htmlToDmd } from "./docx";
import { unpagedResult } from "./text";
import { ConvertError, type ConvertResult } from "./types";

/** MIME parts one message is read through, and how deep they may nest. */
const MAX_PARTS = 500;
const MAX_DEPTH = 12;
/** Attachment names listed. */
const MAX_ATTACHMENTS = 50;

export interface ParsedEmail {
  subject: string;
  from: string;
  to: string;
  cc: string;
  /** The Date header as sent ("" without one). */
  date: string;
  /** Decoded text/plain body, or null. */
  text: string | null;
  /** Decoded text/html body, or null. */
  html: string | null;
  attachments: string[];
}

// ─────────────────────────────────────────────────────────────── bytes and charsets

/** A "binary string": one char per byte. */
function latin1(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return out;
}

function bytesOf(binary: string): Uint8Array {
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i) & 0xff;
  return out;
}

/** Bytes → text in `charset`; an unknown or missing charset reads as UTF-8, and as windows-1250 when that is not valid UTF-8. */
export function decodeCharset(bytes: Uint8Array, charset: string | null): string {
  const name = (charset ?? "").trim().toLowerCase();
  if (name && name !== "utf-8" && name !== "utf8" && name !== "us-ascii") {
    try {
      return new TextDecoder(name).decode(bytes);
    } catch {
      // an unknown label: fall through
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1250").decode(bytes);
  }
}

function decodeBase64(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, "");
  try {
    return bytesOf(atob(clean.slice(0, clean.length - (clean.length % 4 === 1 ? 1 : 0))));
  } catch {
    return new Uint8Array();
  }
}

/** Quoted-printable → bytes; `header`: the Q encoding of RFC 2047, where "_" is a space. */
function decodeQuotedPrintable(text: string, header = false): Uint8Array {
  const src = header ? text.replace(/_/g, " ") : text.replace(/=\r?\n/g, "");
  const out: number[] = [];
  for (let i = 0; i < src.length; i++) {
    const hex = src[i] === "=" ? src.slice(i + 1, i + 3) : "";
    if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
      out.push(Number.parseInt(hex, 16));
      i += 2;
    } else out.push(src.charCodeAt(i) & 0xff);
  }
  return new Uint8Array(out);
}

// ─────────────────────────────────────────────────────────────── headers

/** Header block → lower-cased name → first value, folded lines joined. */
function parseHeaders(block: string): Map<string, string> {
  const headers = new Map<string, string>();
  for (const line of block.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (!headers.has(name)) headers.set(name, line.slice(colon + 1).trim());
  }
  return headers;
}

/** RFC 2047 encoded words ("=?utf-8?B?…?=") and raw 8-bit bytes in a header value → text. */
export function decodeHeader(value: string): string {
  const joined = value.replace(/(\?=)\s+(=\?)/g, "$1$2");
  if (!joined.includes("=?")) return decodeCharset(bytesOf(joined), null).trim();
  return joined
    .replace(/=\?([^?\s]+)\?([bBqQ])\?([^?]*)\?=/g, (_m, charset: string, enc: string, text: string) =>
      decodeCharset(enc.toLowerCase() === "b" ? decodeBase64(text) : decodeQuotedPrintable(text, true), charset.replace(/\*.*$/, "")),
    )
    .trim();
}

/** "text/plain; charset=utf-8; name=\"a.pdf\"" → the type and its parameters. */
function parseValue(value: string): { value: string; params: Map<string, string> } {
  const [head, ...rest] = value.split(";");
  const params = new Map<string, string>();
  for (const part of rest) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    // RFC 2231 "name*=utf-8''…" is read as the plain parameter.
    const name = part.slice(0, eq).trim().toLowerCase().replace(/\*\d*\*?$|\*$/, "");
    let v = part.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1);
    if (!params.has(name)) params.set(name, v);
  }
  return { value: head.trim().toLowerCase(), params };
}

// ─────────────────────────────────────────────────────────────── MIME

function splitMessage(raw: string): { headers: Map<string, string>; body: string } {
  const m = /\r?\n\r?\n/.exec(raw);
  if (!m) return { headers: parseHeaders(raw), body: "" };
  return { headers: parseHeaders(raw.slice(0, m.index)), body: raw.slice(m.index + m[0].length) };
}

function attachmentName(headers: Map<string, string>, type: ReturnType<typeof parseValue>): string {
  const disposition = parseValue(headers.get("content-disposition") ?? "");
  const raw = disposition.params.get("filename") ?? type.params.get("name") ?? "";
  let name = decodeHeader(raw);
  if (/^[\w-]+''/.test(name)) {
    try {
      name = decodeURIComponent(name.replace(/^[\w-]+''/, ""));
    } catch {
      // keep it as it is
    }
  }
  return name.replace(/[\r\n\t]+/g, " ").trim().slice(0, 200);
}

/**
 * A message (bytes of the .eml) → what is kept of it. Walks the MIME tree:
 * the first text/plain and the first text/html that are not attachments
 * become the body, every other leaf (and an embedded message) is an
 * attachment listed by name. Never throws on a malformed message — what
 * cannot be read is left out. Pure.
 */
export function parseEmail(bytes: Uint8Array): ParsedEmail {
  const top = splitMessage(latin1(bytes));
  const out: ParsedEmail = {
    subject: decodeHeader(top.headers.get("subject") ?? ""),
    from: decodeHeader(top.headers.get("from") ?? ""),
    to: decodeHeader(top.headers.get("to") ?? ""),
    cc: decodeHeader(top.headers.get("cc") ?? ""),
    date: decodeHeader(top.headers.get("date") ?? ""),
    text: null,
    html: null,
    attachments: [],
  };
  let parts = 0;

  const visit = (headers: Map<string, string>, body: string, depth: number): void => {
    if (++parts > MAX_PARTS || depth > MAX_DEPTH) return;
    const type = parseValue(headers.get("content-type") ?? "text/plain");
    const boundary = type.params.get("boundary");
    if (type.value.startsWith("multipart/") && boundary) {
      const pieces = body.split(`--${boundary}`);
      // Before the first boundary is the preamble; the piece starting "--" closes the part.
      for (const piece of pieces.slice(1)) {
        if (piece.startsWith("--")) break;
        const part = splitMessage(piece.replace(/^[ \t]*\r?\n/, ""));
        visit(part.headers, part.body.replace(/\r?\n$/, ""), depth + 1);
      }
      return;
    }
    const disposition = parseValue(headers.get("content-disposition") ?? "").value;
    const name = attachmentName(headers, type);
    const isText = type.value === "text/plain" || type.value === "text/html";
    if (disposition === "attachment" || !isText || (name && disposition !== "inline")) {
      // Pictures inside the text (signatures, logos) are not attachments worth naming.
      if (disposition === "inline" && type.value.startsWith("image/")) return;
      if (type.value.startsWith("image/") && !name) return;
      if (out.attachments.length < MAX_ATTACHMENTS) out.attachments.push(name || (type.value === "message/rfc822" ? "přeposlaná zpráva" : type.value));
      return;
    }
    const encoding = (headers.get("content-transfer-encoding") ?? "").trim().toLowerCase();
    const data = encoding === "base64" ? decodeBase64(body) : encoding === "quoted-printable" ? decodeQuotedPrintable(body) : bytesOf(body);
    const text = decodeCharset(data, type.params.get("charset") ?? null);
    if (type.value === "text/plain" && out.text === null) out.text = text;
    else if (type.value === "text/html" && out.html === null) out.html = text;
  };

  visit(top.headers, top.body, 0);
  return out;
}

// ─────────────────────────────────────────────────────────────── to HTML

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
const escapeHtml = (text: string): string => text.replace(/[&<>]/g, (c) => ESCAPES[c]);

/** What an HTML mail carries around its text. */
const MAIL_CHROME = "script, style, noscript, template, svg, canvas, iframe, object, embed, img, form, button, select, textarea, head, link, meta, title";
/** Containers that only group blocks: the walker knows `div`, so they become one. */
const SECTIONS = "main, article, section, header, footer, aside, figure, figcaption, details, summary, address, center, font";

function cleanMailHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const el of Array.from(doc.querySelectorAll(MAIL_CHROME))) el.remove();
  for (const el of Array.from(doc.querySelectorAll(SECTIONS)).reverse()) {
    const div = doc.createElement("div");
    while (el.firstChild) div.appendChild(el.firstChild);
    el.replaceWith(div);
  }
  // Layout tables of HTML mail are not tables of data: their cells are just blocks.
  for (const el of Array.from(doc.querySelectorAll("table, thead, tbody, tfoot, tr, td, th")).reverse()) {
    const div = doc.createElement("div");
    while (el.firstChild) div.appendChild(el.firstChild);
    el.replaceWith(div);
  }
  return doc.body?.innerHTML ?? "";
}

/** Plain text → paragraphs (blank lines) with line breaks kept. */
function plainToHtml(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.replace(/^\n+|\n+$/g, ""))
    .filter((p) => p.trim() !== "")
    .map((p) => `<p>${p.split("\n").map(escapeHtml).join("<br>")}</p>`)
    .join("");
}

/** "12. 3. 2026 14:05" in Prague time; the header as sent when it is not a date. */
function czechDate(header: string): string {
  const t = Date.parse(header);
  if (!header || Number.isNaN(t)) return header;
  return new Date(t).toLocaleString("cs-CZ", { timeZone: "Europe/Prague", day: "numeric", month: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" }).replace(/\s+/g, " ");
}

/**
 * The message as simple HTML: the subject as its heading, a line each for
 * sender, recipients, date and attachment names, then the body — the plain
 * part when there is one with text, else the cleaned HTML part. `cleanHtml`
 * is injected so this stays pure (the converter passes the DOM-based one).
 */
export function emailToHtml(mail: ParsedEmail, cleanHtml: (html: string) => string): string {
  const line = (label: string, value: string) => (value ? `<p>${label}: ${escapeHtml(value)}</p>` : "");
  const head =
    `<h1>${escapeHtml(mail.subject || "(bez předmětu)")}</h1>` +
    line("Od", mail.from) +
    line("Komu", mail.to) +
    line("Kopie", mail.cc) +
    line("Datum", czechDate(mail.date)) +
    line("Přílohy (nepřevedené)", mail.attachments.join(", "));
  const body = mail.text && mail.text.trim() ? plainToHtml(mail.text) : mail.html ? cleanHtml(mail.html) : "";
  return head + body;
}

const QUALITY: ConversionQuality = { footnotes: "none", linked_ratio: 0, columns_pages: 0, headings_from: "none", mn: 0, unsure_pages: [] };

/** .eml bytes → ConvertResult. Throws ConvertError('broken') for a file that is not a message. */
export function convertEmail(data: ArrayBuffer): ConvertResult {
  if (typeof DOMParser === "undefined") throw new ConvertError("unsupported", "Převod e-mailu běží jen v prohlížeči.");
  const mail = parseEmail(new Uint8Array(data));
  if (!mail.from && !mail.subject && !mail.date) throw new ConvertError("broken", "Soubor nevypadá jako e-mailová zpráva (.eml).");
  const doc = new DOMParser().parseFromString(`<!DOCTYPE html><html><head></head><body>${emailToHtml(mail, cleanMailHtml)}</body></html>`, "text/html");
  const out = htmlToDmd(doc.body);
  const warnings: string[] = [];
  if (!mail.text?.trim() && !mail.html) warnings.push("Zpráva nemá žádný text — uložila se jen její hlavička.");
  if (mail.attachments.length) {
    warnings.push(`Přílohy se nepřevádějí (${mail.attachments.length}): pokud v nich má asistent hledat, nahrajte je jako samostatné soubory.`);
  }
  return unpagedResult({ kind: "eml", converter: "eml@1", dmd: out.dmd, quality: QUALITY, warnings });
}
