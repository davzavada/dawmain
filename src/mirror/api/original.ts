import { gunzipSync } from "node:zlib";
import type { AnyNode, Element } from "domhandler";
import { loadHtml } from "@/src/sources/shared/html";
import type { Queryable } from "../db/client";
import { isSeparatorRule } from "../index";
import type { MirrorSource } from "../types";
import type { RenderImage } from "./render";

/**
 * The decision with the court's own formatting (bold, italics, underline,
 * alignment, paragraphs, tables), read from the source's document kept in
 * decision_raw (0014) — the stored text has none. One HTML fragment per
 * source, every source's markup reduced to the same small set of tags:
 *
 *   p (class al-center / al-right / al-justify), br, strong, em, u, sup,
 *   sub, ul, ol, li, table, tr, td, th (colspan, rowspan), hr.dissent,
 *   span.anon (justice: anonymised), p.img (a stored picture)
 *
 * Nothing else survives: no attributes but those, no links, no scripts or
 * styles, no images of the court's server (a picture is the stored one, by
 * order). Sources and their documents:
 *
 *   us       GetText HTML, the RTF in #docContentHidden: \b \i \ul \qc \qr \qj, \par, pictures by order
 *   ns       WebSearch HTML: the page without its metadata tables, chrome and citation note
 *   nss      DokumentOriginal/Html (a Word export): its <body>
 *   justice  finaldoc JSON: header, verdict, justification, information
 *            paragraphs with their styles (alignment, bold, italic)
 *
 * null when there is no document or it cannot be read: the caller falls
 * back to the plain text. Pure apart from originalOf — unit-tested.
 */

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function imageHtml(img: RenderImage): string {
  if (isSeparatorRule(img)) return '<hr class="dissent">';
  if (img.mime !== "image/png" && img.mime !== "image/jpeg" && img.mime !== "image/gif") {
    return `<p class="img-missing">[obrázek ${img.ord + 1}: ${escape(img.mime)} – prohlížeč ho neumí zobrazit]</p>`;
  }
  const size = img.width && img.height ? ` width="${img.width}" height="${img.height}"` : "";
  return `<p class="img"><img src="data:${img.mime};base64,${Buffer.from(img.bytes).toString("base64")}"${size} alt="obrázek ${img.ord + 1}"></p>`;
}

/** Pictures in document order; each placeholder takes the next one. */
function pictures(images: RenderImage[]) {
  const sorted = [...images].sort((a, b) => a.ord - b.ord);
  let next = 0;
  return () => (next < sorted.length ? imageHtml(sorted[next++]) : "");
}

// ---------- HTML (NS, NSS): an allowlist ----------

const KEEP = new Set(["p", "br", "strong", "em", "u", "sup", "sub", "ul", "ol", "li", "table", "tr", "td", "th", "hr"]);
const RENAME: Record<string, string> = { b: "strong", i: "em", h1: "p", h2: "p", h3: "p", h4: "p", h5: "p", h6: "p", center: "p", blockquote: "p", div: "p", tbody: "", thead: "", tfoot: "" };
const DROP = new Set(["script", "style", "head", "title", "meta", "link", "input", "button", "select", "textarea", "form", "noscript", "iframe", "object", "embed", "svg"]);
const BLOCK = new Set(["p", "ul", "ol", "table", "hr"]);

function alignment(el: Element): string | null {
  const style = el.attribs.style ?? "";
  const value = (el.attribs.align ?? /text-align\s*:\s*(\w+)/i.exec(style)?.[1] ?? (el.name === "center" ? "center" : "")).toLowerCase();
  return value === "center" || value === "right" || value === "justify" ? `al-${value}` : null;
}

/** The children of `node`, cleaned: allowlisted tags, their few attributes, text escaped. */
function cleanChildren(nodes: AnyNode[], picture: () => string): string {
  let out = "";
  for (const node of nodes) {
    if (node.type === "text") out += escape((node as unknown as { data: string }).data);
    else if (node.type === "tag" || node.type === "script" || node.type === "style") {
      const el = node as Element;
      const name = el.name.toLowerCase();
      if (DROP.has(name)) continue;
      if (name === "img") {
        // A court's spacer (1×1) is nothing; another picture is the next stored one.
        if (el.attribs.width === "1" && el.attribs.height === "1") continue;
        out += picture();
        continue;
      }
      const inner = cleanChildren(el.children as AnyNode[], picture);
      const tag = name in RENAME ? RENAME[name] : KEEP.has(name) ? name : "";
      if (!tag) {
        out += inner;
        continue;
      }
      if (tag === "br" || tag === "hr") {
        out += `<${tag}>`;
        continue;
      }
      const trimmed = tag === "p" || tag === "td" || tag === "th" ? inner.replace(/^(\s|<br>)+|(\s|<br>)+$/g, "") : inner;
      if (tag === "p" && !trimmed.replace(/<br>|&nbsp;|\s/g, "")) continue;
      let attrs = "";
      const al = tag === "p" || tag === "td" || tag === "th" ? alignment(el) : null;
      if (al) attrs += ` class="${al}"`;
      for (const span of ["colspan", "rowspan"]) {
        if ((tag === "td" || tag === "th") && /^\d{1,2}$/.test(el.attribs[span] ?? "")) attrs += ` ${span}="${el.attribs[span]}"`;
      }
      // A block inside a paragraph (Word nests them) would break the paragraph: let it stand on its own.
      if (tag === "p" && /<(p|ul|ol|table)[ >]/.test(trimmed)) out += trimmed;
      else out += `<${tag}${attrs}>${trimmed}</${tag}>`;
    }
  }
  return out;
}

/** Text left directly between blocks becomes paragraphs (split on blank <br><br>). */
function wrapLoose(html: string): string {
  const parts = html.split(/(<(?:p|ul|ol|table)[\s>][\s\S]*?<\/(?:p|ul|ol|table)>|<hr[^>]*>)/);
  return parts
    .map((part) => {
      if (/^<(p|ul|ol|table|hr)[\s>]/.test(part)) return part;
      return part
        .split(/(?:\s*<br>\s*){2,}/)
        .map((p) => p.replace(/^(\s|<br>)+|(\s|<br>)+$/g, ""))
        .filter((p) => p.replace(/&nbsp;|\s/g, ""))
        .map((p) => `<p>${p}</p>`)
        .join("");
    })
    .join("")
    .replace(/&nbsp;/g, " ");
}

export function nsOriginalHtml(html: string, images: RenderImage[]): string | null {
  const $ = loadHtml(html);
  // The metadata tables (as parseNsDecision drops them), the page chrome and the citation note.
  $("table#tabl, table#box-table-a, .list-intro-heading, script, style").remove();
  $("table").filter((_, table) => $(table).find("td.left-part").length > 0).remove();
  const body = $("body").get(0);
  if (!body) return null;
  // The note sits in a <span> the page never closes (it wraps the whole body), so it goes from the output.
  const out = wrapLoose(cleanChildren(body.children as AnyNode[], pictures(images)))
    .replace(/Citace rozhodnutí Nejvyššího soudu by měla obsahovat[\s\S]{0,800}?nsoud\.cz\.?(?:<\/em>)?/u, "")
    .replace(/<p>\s*<\/p>/g, "");
  return out.replace(/<[^>]+>|\s/g, "").length > 20 ? out : null;
}

export function nssOriginalHtml(html: string, images: RenderImage[]): string | null {
  const $ = loadHtml(html);
  const body = $("body").get(0);
  if (!body) return null;
  const out = wrapLoose(cleanChildren(body.children as AnyNode[], pictures(images)));
  return out.replace(/<[^>]+>|\s/g, "").length > 20 ? out : null;
}

// ---------- RTF (ÚS) ----------

/** End (exclusive) of the group opening at `start`, braces balanced, escapes skipped. */
function groupEnd(rtf: string, start: number): number {
  let depth = 0;
  for (let i = start; i < rtf.length; i++) {
    const ch = rtf[i];
    if (ch === "\\") i++;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i + 1;
  }
  return rtf.length;
}

export function usOriginalHtml(html: string, images: RenderImage[]): string | null {
  const $ = loadHtml(html);
  const rtf = $("#docContentHidden").attr("value");
  if (!rtf?.trim()) return null;
  const picture = pictures(images);
  const paragraphs: string[] = [];
  let line = "";
  let align: string | null = null;
  const on = { b: false, i: false, u: false };
  const open = () => (on.b ? "<strong>" : "") + (on.i ? "<em>" : "") + (on.u ? "<u>" : "");
  const close = () => (on.u ? "</u>" : "") + (on.i ? "</em>" : "") + (on.b ? "</strong>" : "");
  const toggle = (k: keyof typeof on, value: boolean) => {
    if (on[k] === value) return;
    line += close();
    on[k] = value;
    line += open();
  };
  const endParagraph = () => {
    line += close();
    const text = line.replace(/<(strong|em|u)><\/\1>/g, "").trim();
    paragraphs.push(text ? `<p${align ? ` class="al-${align}"` : ""}>${text}</p>` : "");
    line = open();
  };
  for (let i = 0; i < rtf.length; ) {
    const ch = rtf[i];
    if (ch === "{") {
      const end = groupEnd(rtf, i);
      const head = rtf.slice(i, Math.min(end, i + 40));
      if (/^\{\\\*\\shppict\b|^\{\\pict\b/.test(head)) {
        endParagraph();
        paragraphs.push(picture());
        i = end;
        continue;
      }
      // The fallback copy of a picture, and other destinations (\*…), carry no text.
      if (/^\{\\nonshppict\b|^\{\\\*/.test(head)) {
        i = end;
        continue;
      }
      i++;
      continue;
    }
    if (ch === "}") {
      i++;
      continue;
    }
    if (ch === "\\") {
      const esc = rtf[i + 1];
      if (esc === "'") {
        // \'hh: a byte of the document's code page (Windows-1250 in NALUS).
        const byte = Number.parseInt(rtf.slice(i + 2, i + 4), 16);
        if (!Number.isNaN(byte)) line += escape(new TextDecoder("windows-1250").decode(new Uint8Array([byte])));
        i += 4;
        continue;
      }
      if (esc === "{" || esc === "}" || esc === "\\") {
        line += escape(esc);
        i += 2;
        continue;
      }
      const m = /^\\([a-z]+)(-?\d+)? ?/.exec(rtf.slice(i, i + 40));
      if (!m) {
        i++;
        continue;
      }
      const [all, word, num] = m;
      const off = num === "0";
      if (word === "u" && num) {
        // \uN: a Unicode character (negative above 32767), then one fallback character to skip.
        line += escape(String.fromCharCode(Number(num) < 0 ? Number(num) + 65536 : Number(num)));
        i += all.length;
        if (rtf[i] === "?") i++;
        continue;
      }
      if (word === "par") endParagraph();
      else if (word === "line") line += "<br>";
      else if (word === "tab") line += " ";
      else if (word === "b") toggle("b", !off);
      else if (word === "i") toggle("i", !off);
      else if (word === "ul") toggle("u", !off);
      else if (word === "ulnone") toggle("u", false);
      else if (word === "plain") {
        toggle("b", false);
        toggle("i", false);
        toggle("u", false);
      } else if (word === "qc") align = "center";
      else if (word === "qr") align = "right";
      else if (word === "qj") align = "justify";
      else if (word === "ql" || word === "pard") align = null;
      i += all.length;
      continue;
    }
    // Line breaks in RTF source are not text.
    if (ch !== "\n" && ch !== "\r") line += escape(ch);
    i++;
  }
  endParagraph();
  const out = paragraphs.filter(Boolean).join("\n").replace(/[ \t]{2,}/g, " ");
  return out.replace(/<[^>]+>|\s/g, "").length > 20 ? out : null;
}

// ---------- JSON (justice.cz) ----------

interface JusticeParagraph {
  texts?: Array<{ text?: string; anonStyle?: string }>;
  styleLocalId?: number;
}
interface JusticeStyle {
  localId: number;
  alignment?: string;
  bold?: boolean;
  italic?: boolean;
}

export function justiceOriginalHtml(json: string): string | null {
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
  const styles = new Map(((doc.styles as JusticeStyle[] | undefined) ?? []).map((s) => [s.localId, s]));
  const out: string[] = [];
  for (const part of ["header", "verdict", "justification", "information"]) {
    const paragraphs = doc[part];
    if (!Array.isArray(paragraphs)) continue;
    for (const p of paragraphs as JusticeParagraph[]) {
      const style = styles.get(p.styleLocalId ?? -1);
      let inner = (p.texts ?? [])
        .map((t) => (t.anonStyle && t.anonStyle !== "NONE" ? `<span class="anon">${escape(t.text ?? "")}</span>` : escape(t.text ?? "")))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (!inner) continue;
      if (style?.italic) inner = `<em>${inner}</em>`;
      if (style?.bold) inner = `<strong>${inner}</strong>`;
      const al = (style?.alignment ?? "").toLowerCase();
      const cls = al === "center" || al === "right" || al === "justify" ? ` class="al-${al}"` : "";
      out.push(`<p${cls}>${inner}</p>`);
    }
  }
  return out.length ? out.join("\n") : null;
}

// ---------- the document ----------

function decode(bytes: Buffer, contentType: string | null): string {
  let charset = /charset=([^;\s]+)/i.exec(contentType ?? "")?.[1]?.toLowerCase();
  if (!charset) charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(bytes.subarray(0, 2048).toString("latin1"))?.[1]?.toLowerCase();
  if (bytes[0] === 0xff && bytes[1] === 0xfe) charset = "utf-16le";
  try {
    return new TextDecoder(charset ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/** The formatted fragment from a decoded document. */
export function originalFragment(source: MirrorSource, document: string, images: RenderImage[]): string | null {
  switch (source) {
    case "us":
      return usOriginalHtml(document, images);
    case "ns":
      return nsOriginalHtml(document, images);
    case "nss":
      return nssOriginalHtml(document, images);
    case "justice":
      return justiceOriginalHtml(document);
    default:
      return null;
  }
}

/** The stored document of a decision, formatted; null when there is none or it cannot be read. */
export async function originalOf(db: Queryable, source: MirrorSource, id: string, images: RenderImage[]): Promise<string | null> {
  const { rows } = await db.query<{ gz: Buffer; content_type: string | null; status: number }>(
    `SELECT r.gz, r.content_type, r.status FROM mirror.decision_raw r JOIN mirror.decision d ON d.id = r.decision_id
     WHERE d.source = $1 AND d.source_id = $2`,
    [source, id],
  );
  const raw = rows[0];
  if (!raw || raw.status < 200 || raw.status >= 300 || !raw.gz?.length) return null;
  try {
    return originalFragment(source, decode(gunzipSync(raw.gz), raw.content_type), images);
  } catch {
    return null;
  }
}
