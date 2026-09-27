/**
 * Metadata schemas and the rules that combine proposals:
 *
 * - aiProposalSchema — what the model returns through Output.object. Flat,
 *   every field present and nullable, enums where the domain is closed, and
 *   NO length/range/pattern constraints: providers' structured-output
 *   subsets reject or silently drop them, so everything is checked
 *   afterwards, in validateAiProposal.
 * - validateAiProposal — the model's answer is untrusted (the prompt was a
 *   document someone uploaded): every string is sanitized to one line and
 *   capped, identifiers and author surnames must occur in the source text
 *   the model was shown, anything else malformed is dropped field by field.
 * - mergeProposals — heuristics win for identifiers and dates, the AI for
 *   the title, type, summary, keywords and (verified) people, confidence
 *   decides the rest; the uploader's own type hint beats both.
 * - proposalToBibMeta — the provisional BibMeta stored at ingest, before
 *   the user confirms.
 * - bibMetaSchema — server validation of the confirm form: strict (unknown
 *   keys rejected), capped, identifiers normalized, Czech messages.
 *
 * Pure — unit-tested (tests/files-meta-schema.test.ts).
 */

import { z } from "zod";
import { sanitizeLine } from "@/src/files/dmd/normalize";
import { actName, resolveAct } from "@/src/files/index/acts";
import { canonicalCaseNumber, extractIdentKeys, findIdentSpans, normalizeIsbn } from "@/src/files/index/identifiers";
import { foldWord, tokenize } from "@/src/files/text/analyze";
import {
  ANCHOR_LABELS,
  DOC_TYPES,
  TEMPLATE_KINDS,
  type AnchorLabel,
  type BibMeta,
  type DocType,
  type MetaField,
  type ProposedField,
  type ProposedMeta,
  type TemplateKind,
} from "@/src/files/types";
import { CZECH_MONTHS, isoDate, isSurnameWord, issnValid, ORDINALS, parseNamesLine, stripDegrees, surnameOf, trimDoi } from "./heuristics";

// ---------------------------------------------------------------------------
// Caps (shared by the confirm form, the AI validation and proposalToBibMeta)

export const META_CAPS = {
  title: 300,
  subtitle: 300,
  name: 120,
  names: 10,
  edition: 40,
  publisher: 200,
  place: 100,
  series: 200,
  isbns: 10,
  containerTitle: 300,
  volume: 20,
  issue: 20,
  pagesRange: 30,
  actName: 200,
  sectionRange: 60,
  court: 120,
  caseNumber: 60,
  keywords: 8,
  keyword: 60,
  summary: 600,
  doi: 200,
} as const;

const COMMENTED_ACT_RE = /^(zak:\d{1,4}\/\d{4}|eu:\d{5}[A-Z]\d{4})$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ECLI_RE = /^ECLI:[A-Z]{2}:[A-Z0-9]{1,7}:\d{4}:[A-Z0-9.]{1,60}$/;
const DOI_RE = /^10\.\d{4,9}\/\S+$/;
const LANGUAGE_RE = /^[a-z]{2,3}$/;

// ---------------------------------------------------------------------------
// The model's schema

const nullableText = (description: string) => z.string().nullable().describe(description);

/**
 * The model's answer (Output.object). Every field is required and nullable
 * so strict structured-output modes accept it; no min/max/regex — those are
 * enforced by validateAiProposal.
 */
export const aiProposalSchema = z
  .object({
    doc_type: z
      .enum(DOC_TYPES)
      .nullable()
      .describe(
        "kniha = book/monograph/textbook/proceedings; kapitola = chapter in an edited book; clanek = journal article; komentar = commentary on an act (Komentář); vzor = template of a contract or court filing; rozhodnuti = court decision; jine = other",
      ),
    title: nullableText("Title as printed on the title page, in normal capitalization (not ALL CAPS). Decision: its form — Rozsudek, Usnesení, Nález, Stanovisko."),
    subtitle: nullableText("Subtitle; for a commentary keep the word Komentář here."),
    authors: z.array(z.string()).describe("Personal names of the authors exactly as printed, without academic titles. Empty when unknown."),
    editors: z.array(z.string()).describe('Editors: names followed by "a kol." on a commentary title page, "(eds.)", "Editoři:". Without titles.'),
    year: z.number().nullable().describe("Year of publication of this edition, or of the decision."),
    edition: nullableText('Edition number with a dot, e.g. "2." for "2. vydání".'),
    publisher: nullableText("Publisher as printed in the colophon (tiráž), without the legal form."),
    place: nullableText("Place of publication."),
    series: nullableText("Series (edice), when printed."),
    isbn: z.array(z.string()).describe("ISBNs of THIS book exactly as printed in its colophon. Never ISBNs of cited works."),
    issn: nullableText("ISSN of the journal, exactly as printed."),
    doi: nullableText("DOI of THIS article, exactly as printed."),
    container_title: nullableText("Journal (article) or host book (chapter)."),
    volume: nullableText("Volume (ročník) of the journal."),
    issue: nullableText("Issue (číslo) of the journal."),
    pages_range: nullableText('Printed page range of an article or chapter, e.g. "417–425".'),
    commented_act: nullableText('Commentary only: the act it comments as named in the title, e.g. "zákon č. 89/2012 Sb., občanský zákoník".'),
    anchor_label: z.enum(ANCHOR_LABELS).nullable().describe("Label of the marginal numbers the text uses, if any."),
    template_kind: z.enum(TEMPLATE_KINDS).nullable().describe("Template only: what kind of template it is."),
    court: nullableText("Decision only: the court that decided, in the nominative (Nejvyšší soud)."),
    case_number: nullableText("Decision only: its spisová značka exactly as printed (e.g. 25 Cdo 1234/2019)."),
    ecli: nullableText("Decision only: its ECLI exactly as printed."),
    decided_on: nullableText("Decision only: date of the decision as YYYY-MM-DD."),
    keywords: z.array(z.string()).describe('Up to 8 Czech keywords ("Klíčová slova" when printed).'),
    summary: nullableText("One to three Czech sentences (at most 600 characters) on what the document covers."),
    language: nullableText("ISO 639-1 code of the main language, e.g. cs."),
  })
  .describe("Bibliographic metadata of one uploaded legal document.");

export type AiProposal = z.infer<typeof aiProposalSchema>;

// ---------------------------------------------------------------------------
// Value normalizers (shared)

const NULLISH = new Set(["null", "none", "nil", "unknown", "n/a", "na", "-", "—", "–", "?", "neuvedeno", "není uvedeno", "neznámý", "neznámé", "neznámá", "nezjištěno"]);

/** One sanitized line, or null for empty and "unknown"-like values. */
function text(v: unknown, max: number): string | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const s = sanitizeLine(String(v), max);
  if (!s || NULLISH.has(s.toLowerCase())) return null;
  return s;
}

function fold(s: string): string {
  return foldWord(s).replace(/\s+/g, " ").trim();
}

/** Identifier inputs longer than this are not identifiers (and never reach a regex). */
const MAX_IDENT_INPUT = 500;

/** "0323-0619", "03230619", "ISSN 0323 0619" → "0323-0619" when the check digit holds. */
export function normalizeIssn(raw: string): string | null {
  if (raw.length > MAX_IDENT_INPUT) return null;
  const d = raw.toUpperCase().replace(/^\s*E?-?ISSN\s*:?\s*/i, "").replace(/[^0-9X]/g, "");
  if (!/^\d{7}[\dX]$/.test(d) || !issnValid(d)) return null;
  return `${d.slice(0, 4)}-${d.slice(4)}`;
}

/** "https://doi.org/10.14712/X." / "doi: 10.14712/x" → "10.14712/x"; null when not a DOI. */
export function normalizeDoi(raw: string): string | null {
  if (raw.length > MAX_IDENT_INPUT) return null;
  const d = trimDoi(raw.trim().replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi\s*:\s*)/i, "")).toLowerCase();
  return DOI_RE.test(d) && d.length <= META_CAPS.doi ? d : null;
}

/** "ecli:cz:ns:2019:25.CDO.1234.2019.1" → upper case, spaces removed; null when malformed. */
export function normalizeEcli(raw: string): string | null {
  if (raw.length > MAX_IDENT_INPUT) return null;
  const e = raw.replace(/\s+/g, "").replace(/\.+$/, "").toUpperCase();
  return ECLI_RE.test(e) ? e : null;
}

/** "2019-04-24", "24. 4. 2019", "24.04.2019", "24. dubna 2019" → "2019-04-24"; null when not a real date. */
export function normalizeDate(raw: string): string | null {
  if (raw.length > MAX_IDENT_INPUT) return null;
  const s = raw.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (iso) return isoDate(Number(iso[3]), Number(iso[2]), Number(iso[1]));
  const cz = /^(\d{1,2})\.\s*(?:(\d{1,2})\.|(\p{L}+))\s*(\d{4})$/u.exec(s);
  if (!cz) return null;
  const month = cz[2] ? Number(cz[2]) : (CZECH_MONTHS[cz[3].toLowerCase()] ?? 0);
  return isoDate(Number(cz[1]), month, Number(cz[4]));
}

/** "89/2012", "89/2012 Sb.", "zákon č. 89/2012 Sb.", "OZ", "32016R0679", "zak:89/2012" → an act id; null when unknown. */
export function normalizeAct(raw: string): string | null {
  if (raw.length > MAX_IDENT_INPUT) return null;
  const s = raw.trim();
  if (COMMENTED_ACT_RE.test(s)) return s;
  const bare = /^(\d{1,4})\s*\/\s*(\d{4})(?:\s*Sb\.?)?$/.exec(s);
  if (bare) return `zak:${Number(bare[1])}/${bare[2]}`;
  const celex = /^(?:eu:)?(\d{5}[A-Z]\d{4})$/i.exec(s);
  if (celex) return `eu:${celex[1].toUpperCase()}`;
  const act = resolveAct(s)?.act ?? null;
  return act && COMMENTED_ACT_RE.test(act) ? act : null;
}

/** Page range with an en dash: "417-425" → "417–425". */
function pagesRange(s: string): string {
  return s.replace(/\s*[-‐‑‒—−]\s*/g, "–").replace(/\s*–\s*/g, "–");
}

/** "2", "2.", "2. vydání", "druhé vydání" → "2."; else the text (≤ 40). */
export function normalizeEdition(raw: string): string | null {
  const s = text(raw, 200);
  if (!s) return null;
  const n = /^(\d{1,2})\.?(?:\s*(?:,\s*)?(?:[\p{L}]+\s+){0,4}(?:vydání|vyd\.))?$/iu.exec(s);
  if (n) return `${Number(n[1])}.`;
  const w = /^(?:vydání\s+)?(první|druhé|třetí|čtvrté|páté|šesté|sedmé|osmé|deváté|desáté)(?:\s+vydání)?$/iu.exec(s);
  if (w) return `${ORDINALS[w[1].toLowerCase()]}.`;
  return sanitizeLine(s, META_CAPS.edition);
}

/**
 * Split list items that hold several names ("Petrov, J., Výtisk, M.",
 * "A; B"), drop degrees and anything after the name ("Jan Petrov, CSc.,
 * Univerzita Karlova" → "Jan Petrov"), dedupe. A lone surname ("Beran")
 * is kept; what does not read as a personal name is dropped.
 */
function splitNames(items: string[]): string[] {
  const out: string[] = [];
  for (const item of items) {
    const line = text(item, 400);
    if (!line) continue;
    const head = stripDegrees(line).text.split(",")[0].trim();
    const names = (parseNamesLine(line) ?? parseNamesLine(head))?.names ?? (isSurnameWord(head) ? [head] : []);
    for (const name of names) {
      // "Výtisk" next to "Výtisk, M." is the same person.
      const lone = !/[\s,]/.test(name);
      if (!out.some((o) => fold(o) === fold(name) || (lone && surnameOf(o) === fold(name)))) out.push(name);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// validateAiProposal

interface SourceIndex {
  folded: string;
  tokens: Set<string>;
  keys: Set<string>;
  issns: Set<string>;
  years: Set<string>;
}

function indexSource(source: string): SourceIndex {
  const tokens = new Set<string>();
  for (const t of tokenize(source)) tokens.add(foldWord(t.lower));
  const keys = new Set<string>();
  for (const span of findIdentSpans(source)) for (const k of span.keys) keys.add(k);
  const issns = new Set<string>();
  for (const m of source.matchAll(/(?<!\d)(\d{4})\s*[-‐‑–]?\s*(\d{3}[\dXx])(?![\dXx])/g)) {
    const n = normalizeIssn(m[1] + m[2]);
    if (n) issns.add(n);
  }
  const years = new Set<string>();
  for (const m of source.matchAll(/(?<!\d)(1[5-9]\d\d|20\d\d)(?!\d)/g)) years.add(m[1]);
  return { folded: fold(source), tokens, keys, issns, years };
}

/** Every word of the name's surname occurs in the source (as a whole word, folded). */
function surnameInSource(name: string, src: SourceIndex): boolean {
  const surname = surnameOf(name);
  if (!surname) return false;
  const parts = surname.split(/[\s\-‐'’]+/).filter((p) => p.length >= 2);
  return parts.length > 0 && parts.every((p) => src.tokens.has(p));
}

function field<T>(value: T, confidence: number): ProposedField<T> {
  return { value, source: "ai", confidence };
}

const AI_FIELDS = Object.keys(aiProposalSchema.shape) as Array<keyof AiProposal>;

/**
 * The model's answer → proposals (see the header). `sourceText` is exactly
 * what the model was shown (buildMetaPrompt's sourceText). Never throws; a
 * malformed answer yields fewer (or no) fields. Pure.
 */
export function validateAiProposal(raw: unknown, sourceText: string): ProposedMeta {
  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const src = indexSource(typeof sourceText === "string" ? sourceText : "");
  const out: ProposedMeta = {};
  const put = <K extends MetaField>(key: K, value: BibMeta[K] | null | undefined, confidence: number) => {
    if (value === null || value === undefined || (Array.isArray(value) && value.length === 0)) return;
    (out as Record<string, unknown>)[key] = field(value, confidence);
  };
  const get = <K extends keyof AiProposal>(key: K): AiProposal[K] | undefined => {
    const parsed = aiProposalSchema.shape[key].safeParse(obj[key]);
    return parsed.success ? (parsed.data as AiProposal[K]) : undefined;
  };
  // A list longer than this is not metadata (a runaway answer); the rest is ignored.
  const list = (key: "authors" | "editors" | "isbn" | "keywords"): string[] => (get(key) ?? []).slice(0, 50).filter((s) => typeof s === "string");

  for (const key of AI_FIELDS) {
    switch (key) {
      case "doc_type":
        put("doc_type", get("doc_type") as DocType | null | undefined, 0.7);
        break;
      case "title": {
        const t = text(get("title"), META_CAPS.title);
        put("title", t, t && src.folded.includes(fold(t)) ? 0.8 : 0.7);
        break;
      }
      case "subtitle":
        put("subtitle", text(get("subtitle"), META_CAPS.subtitle), 0.6);
        break;
      case "authors":
      case "editors": {
        const names = splitNames(list(key)).filter((n) => surnameInSource(n, src)).slice(0, META_CAPS.names);
        put(key, names, 0.75);
        break;
      }
      case "year": {
        const y = get("year");
        if (typeof y === "number" && Number.isInteger(y) && y >= 1500 && y <= 2100) put("year", y, src.years.has(String(y)) ? 0.7 : 0.35);
        break;
      }
      case "edition": {
        const e = get("edition");
        put("edition", typeof e === "string" ? normalizeEdition(e) : null, 0.65);
        break;
      }
      case "publisher":
        put("publisher", text(get("publisher"), META_CAPS.publisher), 0.6);
        break;
      case "place":
        put("place", text(get("place"), META_CAPS.place), 0.6);
        break;
      case "series":
        put("series", text(get("series"), META_CAPS.series), 0.6);
        break;
      case "container_title":
        put("container_title", text(get("container_title"), META_CAPS.containerTitle), 0.65);
        break;
      case "volume":
        put("volume", text(get("volume"), META_CAPS.volume), 0.6);
        break;
      case "issue":
        put("issue", text(get("issue"), META_CAPS.issue), 0.6);
        break;
      case "pages_range": {
        const p = text(get("pages_range"), META_CAPS.pagesRange);
        put("pages_range", p ? pagesRange(p) : null, 0.6);
        break;
      }
      case "isbn": {
        const isbns: string[] = [];
        for (const raw of list("isbn")) {
          const n = normalizeIsbn(raw);
          if (n && src.keys.has(`isbn:${n}`) && !isbns.includes(n)) isbns.push(n);
        }
        put("isbn", isbns.slice(0, META_CAPS.isbns), 0.8);
        break;
      }
      case "issn": {
        const raw = get("issn");
        const n = typeof raw === "string" ? normalizeIssn(raw) : null;
        put("issn", n && src.issns.has(n) ? n : null, 0.8);
        break;
      }
      case "doi": {
        const raw = get("doi");
        const d = typeof raw === "string" ? normalizeDoi(raw) : null;
        put("doi", d && src.keys.has(`doi:${d}`) ? d : null, 0.8);
        break;
      }
      case "ecli": {
        const raw = get("ecli");
        const e = typeof raw === "string" ? normalizeEcli(raw) : null;
        put("ecli", e && src.keys.has(`ecli:${e.slice(5).toLowerCase()}`) ? e : null, 0.85);
        break;
      }
      case "case_number": {
        const raw = text(get("case_number"), META_CAPS.caseNumber + 20);
        if (!raw) break;
        const keys = extractIdentKeys(raw).filter((k) => k.startsWith("sz:"));
        if (keys.some((k) => src.keys.has(k))) put("case_number", canonicalCaseNumber(raw)?.display ?? raw, 0.8);
        break;
      }
      case "commented_act": {
        const raw = get("commented_act");
        const act = typeof raw === "string" ? normalizeAct(raw) : null;
        if (act) {
          put("commented_act", act, 0.7);
          put("commented_act_name", actName(act) ?? resolveAct(raw as string)?.name ?? null, 0.7);
        }
        break;
      }
      case "anchor_label":
        put("anchor_label", get("anchor_label") as AnchorLabel | null | undefined, 0.6);
        break;
      case "template_kind":
        put("template_kind", get("template_kind") as TemplateKind | null | undefined, 0.6);
        break;
      case "court":
        put("court", text(get("court"), META_CAPS.court), 0.65);
        break;
      case "decided_on": {
        const raw = get("decided_on");
        const d = typeof raw === "string" ? normalizeDate(raw) : null;
        if (d) put("decided_on", d, src.years.has(d.slice(0, 4)) ? 0.7 : 0.35);
        break;
      }
      case "keywords": {
        const kws: string[] = [];
        for (const k of list("keywords")) {
          const s = text(k, META_CAPS.keyword);
          if (s && !kws.some((o) => fold(o) === fold(s))) kws.push(s);
        }
        put("keywords", kws.slice(0, META_CAPS.keywords), 0.6);
        break;
      }
      case "summary":
        put("summary", text(get("summary"), META_CAPS.summary), 0.6);
        break;
      case "language": {
        const l = text(get("language"), 10)?.toLowerCase() ?? null;
        put("language", l && LANGUAGE_RE.test(l) ? l : null, 0.7);
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// mergeProposals

/** Heuristics win (when reasonably sure): verified against the text by construction. */
const HEURISTIC_FIRST = new Set<MetaField>(["isbn", "issn", "doi", "ecli", "case_number", "year", "decided_on"]);
/** The model wins: judgement over the whole text beats line guessing. */
const AI_FIRST = new Set<MetaField>(["title", "subtitle", "doc_type", "summary", "keywords", "authors", "editors"]);
/** Fields that follow their lead's winner, so a title never gets a foreign subtitle. */
const FOLLOWERS: Partial<Record<MetaField, MetaField>> = { subtitle: "title", commented_act_name: "commented_act" };

function comparable(v: unknown): string {
  if (Array.isArray(v)) return v.map((x) => comparable(x)).sort().join("|");
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return fold(v).replace(/[.,;:\s]+$/, "");
  return JSON.stringify(v ?? null);
}

function pick(key: MetaField, h: ProposedField | undefined, a: ProposedField | undefined): { field: ProposedField; side: "h" | "a" } | null {
  if (!h && !a) return null;
  if (!a) return { field: h!, side: "h" };
  if (!h) return { field: a, side: "a" };
  let side: "h" | "a";
  if (h.source === "user") side = "h";
  else if (a.source === "user") side = "a";
  else if (HEURISTIC_FIRST.has(key)) side = h.confidence >= 0.5 || h.confidence >= a.confidence ? "h" : "a";
  else if (AI_FIRST.has(key)) side = "a";
  else side = a.confidence > h.confidence ? "a" : "h";
  const chosen = side === "h" ? h : a;
  // Two independent readings that agree are stronger than either.
  if (comparable(h.value) === comparable(a.value)) {
    return { field: { ...chosen, confidence: Math.min(0.95, Math.round((Math.max(h.confidence, a.confidence) + 0.1) * 100) / 100) }, side };
  }
  return { field: chosen, side };
}

/**
 * Heuristic and AI proposals → one proposal per field (see the header). A
 * "user" proposal (the uploader's type hint) always wins. Pure.
 */
export function mergeProposals(heuristic: ProposedMeta, ai: ProposedMeta | null): ProposedMeta {
  const h = (heuristic ?? {}) as Record<string, ProposedField | undefined>;
  const a = (ai ?? {}) as Record<string, ProposedField | undefined>;
  const out: Record<string, ProposedField> = {};
  const sides = new Map<string, "h" | "a">();
  const keys = new Set([...Object.keys(h), ...Object.keys(a)]) as Set<MetaField>;
  for (const key of keys) {
    if (FOLLOWERS[key]) continue;
    const chosen = pick(key, h[key], a[key]);
    if (!chosen) continue;
    out[key] = chosen.field;
    sides.set(key, chosen.side);
  }
  for (const [follower, lead] of Object.entries(FOLLOWERS) as Array<[MetaField, MetaField]>) {
    const side = sides.get(lead);
    if (!side) {
      const chosen = pick(follower, h[follower], a[follower]);
      if (chosen) out[follower] = chosen.field;
      continue;
    }
    const own = (side === "h" ? h : a)[follower];
    const other = (side === "h" ? a : h)[follower];
    const leadsAgree = !!h[lead] && !!a[lead] && comparable(h[lead]!.value) === comparable(a[lead]!.value);
    const chosen = own ?? (leadsAgree ? other : undefined);
    if (chosen) out[follower] = chosen;
  }
  return out as ProposedMeta;
}

// ---------------------------------------------------------------------------
// proposalToBibMeta

/** "C:\\x\\Petrov_OZ-komentar.pdf" → "Petrov_OZ-komentar"; "" → "Bez názvu". */
function titleFromFileName(name: string): string {
  const base = String(name ?? "").replace(/^.*[\\/]/, "").replace(/\.[A-Za-z0-9]{1,5}$/, "");
  return sanitizeLine(base, META_CAPS.title) || "Bez názvu";
}

function capList(v: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    const s = text(item, maxLen);
    if (s && !out.some((o) => fold(o) === fold(s))) out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}

function inList<T extends string>(v: unknown, list: readonly T[]): T | null {
  return typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : null;
}

/**
 * The provisional BibMeta of a document from its proposals: every value
 * capped and normalized as bibMetaBaseSchema expects (so the result always
 * passes it), fields of other document types left empty (a decision's court
 * on a book, a commentary's act on an article), the title falling back to
 * the file name without its extension. Pure.
 */
export function proposalToBibMeta(p: ProposedMeta, fallbackTitle: string): BibMeta {
  const v = (key: MetaField): unknown => (p as Record<string, ProposedField | undefined>)?.[key]?.value;
  const docType = inList(v("doc_type"), DOC_TYPES) ?? "jine";
  const str = (key: MetaField, max: number) => text(v(key), max);
  const year = v("year");
  const isbn = (Array.isArray(v("isbn")) ? (v("isbn") as unknown[]) : [])
    .map((x) => (typeof x === "string" ? normalizeIsbn(x) : null))
    .filter((x, i, all): x is string => !!x && all.indexOf(x) === i)
    .slice(0, META_CAPS.isbns);
  const issn = typeof v("issn") === "string" ? normalizeIssn(v("issn") as string) : null;
  const doi = typeof v("doi") === "string" ? normalizeDoi(v("doi") as string) : null;
  const act = docType === "komentar" && typeof v("commented_act") === "string" ? normalizeAct(v("commented_act") as string) : null;
  const decision = docType === "rozhodnuti";
  const ecli = decision && typeof v("ecli") === "string" ? normalizeEcli(v("ecli") as string) : null;
  const decided = decision && typeof v("decided_on") === "string" ? normalizeDate(v("decided_on") as string) : null;
  const language = text(v("language"), 10)?.toLowerCase();
  const edition = typeof v("edition") === "string" ? normalizeEdition(v("edition") as string) : null;
  const pages = str("pages_range", META_CAPS.pagesRange);
  return {
    doc_type: docType,
    title: str("title", META_CAPS.title) ?? titleFromFileName(fallbackTitle),
    subtitle: str("subtitle", META_CAPS.subtitle),
    authors: capList(v("authors"), META_CAPS.names, META_CAPS.name),
    editors: capList(v("editors"), META_CAPS.names, META_CAPS.name),
    year: typeof year === "number" && Number.isInteger(year) && year >= 1500 && year <= 2100 ? year : null,
    edition,
    publisher: str("publisher", META_CAPS.publisher),
    place: str("place", META_CAPS.place),
    series: str("series", META_CAPS.series),
    isbn,
    issn,
    doi,
    container_title: str("container_title", META_CAPS.containerTitle),
    volume: str("volume", META_CAPS.volume),
    issue: str("issue", META_CAPS.issue),
    pages_range: pages ? pagesRange(pages) : null,
    commented_act: act,
    commented_act_name: act ? (str("commented_act_name", META_CAPS.actName) ?? actName(act)) : null,
    section_range: str("section_range", META_CAPS.sectionRange),
    anchor_label: inList(v("anchor_label"), ANCHOR_LABELS),
    template_kind: docType === "vzor" ? inList(v("template_kind"), TEMPLATE_KINDS) : null,
    court: decision ? str("court", META_CAPS.court) : null,
    case_number: decision ? (() => {
      const c = str("case_number", META_CAPS.caseNumber);
      return c ? (canonicalCaseNumber(c)?.display ?? c) : null;
    })() : null,
    ecli,
    decided_on: decided,
    keywords: capList(v("keywords"), META_CAPS.keywords, META_CAPS.keyword),
    summary: str("summary", META_CAPS.summary),
    language: language && LANGUAGE_RE.test(language) ? language : "cs",
  };
}

// ---------------------------------------------------------------------------
// bibMetaSchema — the confirm form

/** Form values: "" / whitespace / null / undefined → null; strings sanitized to one line. */
function formText(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (typeof v === "number") return String(v);
  if (typeof v !== "string") return v;
  const s = sanitizeLine(v, 100_000);
  return s === "" ? null : s;
}

const optionalText = (max: number, label: string) =>
  z.preprocess(formText, z.string({ error: `${label}: neplatná hodnota.` }).max(max, `${label} může mít nejvýš ${max} znaků.`).nullable());

/** A list from an array or a textarea (one item per line or separated by ";"): sanitized, empty items dropped, deduped. */
function formList(v: unknown): unknown {
  if (v === undefined || v === null || v === "") return [];
  const items = typeof v === "string" ? v.split(/\n|;/) : Array.isArray(v) ? v : null;
  if (!items) return v;
  const out: unknown[] = [];
  for (const item of items) {
    const s = typeof item === "string" ? sanitizeLine(item, 100_000) : item;
    if (s === "" || s === null || s === undefined) continue;
    if (typeof s === "string" && out.some((o) => typeof o === "string" && fold(o) === fold(s))) continue;
    out.push(s);
  }
  return out;
}

const textList = (maxItems: number, maxLen: number, label: string, itemLabel: string) =>
  z.preprocess(
    formList,
    z
      .array(z.string({ error: `${label}: neplatná hodnota.` }).max(maxLen, `${itemLabel} může mít nejvýš ${maxLen} znaků.`))
      .max(maxItems, `${label}: nejvýš ${maxItems} položek.`),
  );

function formEnum<T extends string>(list: readonly [T, ...T[]], message: string) {
  return z.preprocess((v) => (v === undefined || v === null || v === "" ? null : v), z.enum(list, { error: message }).nullable());
}

/**
 * The confirm/save form WITHOUT the cross-field rule (a commentary needs its
 * act): what a draft "Uložit" may store and what proposalToBibMeta always
 * satisfies.
 */
export const bibMetaBaseSchema = z
  .strictObject({
    doc_type: z.enum(DOC_TYPES, { error: "Vyberte typ dokumentu." }),
    title: z.preprocess(
      formText,
      z.string({ error: "Vyplňte název." }).min(1, "Vyplňte název.").max(META_CAPS.title, `Název může mít nejvýš ${META_CAPS.title} znaků.`),
    ),
    subtitle: optionalText(META_CAPS.subtitle, "Podnázev"),
    authors: textList(META_CAPS.names, META_CAPS.name, "Autoři", "Jméno autora"),
    editors: textList(META_CAPS.names, META_CAPS.name, "Editoři", "Jméno editora"),
    year: z.preprocess(
      (v) => (v === undefined || v === null || v === "" ? null : typeof v === "string" && /^\s*\d+\s*$/.test(v) ? Number(v) : v),
      z
        .number({ error: "Rok zadejte číslem." })
        .int("Rok zadejte celým číslem.")
        .min(1500, "Rok musí být mezi 1500 a 2100.")
        .max(2100, "Rok musí být mezi 1500 a 2100.")
        .nullable(),
    ),
    edition: z.preprocess(
      (v) => (typeof v === "string" ? normalizeEdition(v) : formText(v)),
      z.string({ error: "Vydání: neplatná hodnota." }).max(META_CAPS.edition, `Vydání může mít nejvýš ${META_CAPS.edition} znaků.`).nullable(),
    ),
    publisher: optionalText(META_CAPS.publisher, "Nakladatel"),
    place: optionalText(META_CAPS.place, "Místo vydání"),
    series: optionalText(META_CAPS.series, "Edice"),
    isbn: z.preprocess(
      formList,
      z
        .array(
          z
            .string({ error: "ISBN: neplatná hodnota." })
            .refine((s) => normalizeIsbn(s) !== null, { error: "Neplatné ISBN (nesedí kontrolní číslice)." })
            .transform((s) => normalizeIsbn(s)!),
        )
        .max(META_CAPS.isbns, `ISBN: nejvýš ${META_CAPS.isbns} položek.`)
        .transform((list) => [...new Set(list)]),
    ),
    issn: z.preprocess(
      formText,
      z
        .string({ error: "ISSN: neplatná hodnota." })
        .refine((s) => normalizeIssn(s) !== null, { error: "Neplatné ISSN (očekává se např. 1210-6410)." })
        .transform((s) => normalizeIssn(s)!)
        .nullable(),
    ),
    doi: z.preprocess(
      (v) => {
        const s = formText(v);
        return typeof s === "string" ? (normalizeDoi(s) ?? s) : s;
      },
      z.string({ error: "DOI: neplatná hodnota." }).max(META_CAPS.doi, "DOI je příliš dlouhé.").regex(DOI_RE, "Neplatné DOI (očekává se např. 10.14712/23366478.2020.12).").nullable(),
    ),
    container_title: optionalText(META_CAPS.containerTitle, "Časopis nebo sborník"),
    volume: optionalText(META_CAPS.volume, "Ročník"),
    issue: optionalText(META_CAPS.issue, "Číslo"),
    pages_range: z.preprocess(
      (v) => {
        const s = formText(v);
        return typeof s === "string" ? pagesRange(s) : s;
      },
      z
        .string({ error: "Rozsah stran: neplatná hodnota." })
        .max(META_CAPS.pagesRange, `Rozsah stran může mít nejvýš ${META_CAPS.pagesRange} znaků.`)
        .regex(/^[\p{L}\p{N}.,– ]+$/u, "Rozsah stran zadejte např. jako 417–425.")
        .nullable(),
    ),
    commented_act: z.preprocess(
      (v) => {
        const s = formText(v);
        return typeof s === "string" ? (normalizeAct(s) ?? s) : s;
      },
      z
        .string({ error: "Komentovaný předpis: neplatná hodnota." })
        .regex(COMMENTED_ACT_RE, "Komentovaný předpis zadejte číslem a rokem, např. 89/2012 (nebo CELEX 32016R0679).")
        .nullable(),
    ),
    commented_act_name: optionalText(META_CAPS.actName, "Název předpisu"),
    section_range: optionalText(META_CAPS.sectionRange, "Rozsah oddílů"),
    anchor_label: formEnum(ANCHOR_LABELS, "Označení marginálních čísel: vyberte z nabídky."),
    template_kind: formEnum(TEMPLATE_KINDS, "Druh vzoru: vyberte z nabídky."),
    court: optionalText(META_CAPS.court, "Soud"),
    case_number: z.preprocess(
      (v) => {
        const s = formText(v);
        return typeof s === "string" && s.length <= META_CAPS.caseNumber ? (canonicalCaseNumber(s)?.display ?? s) : s;
      },
      z.string({ error: "Spisová značka: neplatná hodnota." }).max(META_CAPS.caseNumber, `Spisová značka může mít nejvýš ${META_CAPS.caseNumber} znaků.`).nullable(),
    ),
    ecli: z.preprocess(
      (v) => {
        const s = formText(v);
        return typeof s === "string" ? (normalizeEcli(s) ?? s) : s;
      },
      z.string({ error: "ECLI: neplatná hodnota." }).regex(ECLI_RE, "Neplatné ECLI (očekává se např. ECLI:CZ:NS:2019:25.CDO.1234.2019.1).").nullable(),
    ),
    decided_on: z.preprocess(
      (v) => {
        const s = formText(v);
        return typeof s === "string" ? (normalizeDate(s) ?? s) : s;
      },
      z
        .string({ error: "Datum rozhodnutí: neplatná hodnota." })
        .regex(ISO_DATE_RE, "Datum rozhodnutí zadejte jako 24. 4. 2019.")
        .refine((s) => normalizeDate(s) !== null, { error: "Datum rozhodnutí neexistuje." })
        .nullable(),
    ),
    keywords: textList(META_CAPS.keywords, META_CAPS.keyword, "Klíčová slova", "Klíčové slovo"),
    summary: optionalText(META_CAPS.summary, "Shrnutí"),
    language: z.preprocess(
      (v) => {
        const s = formText(v);
        return s === null ? "cs" : typeof s === "string" ? s.toLowerCase() : s;
      },
      z.string({ error: "Jazyk: neplatná hodnota." }).regex(LANGUAGE_RE, "Jazyk zadejte kódem, např. cs."),
    ),
  })
  .transform((m): BibMeta => ({
    ...m,
    // The act's canonical name when the form left it empty.
    commented_act_name: m.commented_act_name ?? (m.commented_act ? actName(m.commented_act) : null),
  }));

/**
 * Server validation of the confirm form (plan §4: a commentary is
 * confirmed only with its commented act, which drives the act filter of
 * files_search). Unknown keys are rejected; messages are Czech.
 */
export const bibMetaSchema: z.ZodType<BibMeta> = bibMetaBaseSchema.refine((m) => m.doc_type !== "komentar" || !!m.commented_act, {
  error: "U komentáře vyplňte komentovaný předpis (např. 89/2012).",
  path: ["commented_act"],
});
