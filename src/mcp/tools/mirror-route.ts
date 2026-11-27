import { SourceError, toToolError } from "@/src/sources/shared/errors";
import { justiceCourtCode } from "@/src/sources/justice";
import { DOC_PAGE_CHARS, interleave, uniqueQueries } from "@/src/sources/shared/text";
import {
  getMirrorDecision,
  markedExcerpt,
  MIRROR_COURTS,
  MirrorRefusal,
  mirrorDecisionsByCase,
  mirrorProvisions,
  searchMirror,
  type MirrorCitedBySummary,
  type MirrorCourt,
  type MirrorHit,
  type MirrorLinkedDecision,
  type MirrorProvisionHit,
  type MirrorProvisionResult,
  type MirrorSearchParams,
} from "@/src/sources/mirror";
import { continuationHint, dateRangeError } from "./shared";
import { readDecision } from "./reading";

/**
 * The case-law tools answered from the home mirror instead of the courts —
 * for every caller, wherever the mirror is configured (./index.ts, routed).
 * Same tool names, same parameters: a handler here
 * either answers the call or returns `{ fallback }` with the reason, and the
 * registration wrapper (./index.ts) then runs the live tool, telling the
 * model why. The Czech courts are answered here whenever the mirror can
 * answer: words, operators, every filter the mirror holds data for (form,
 * senate, registry, area, web date, cited provision, own značka), any page.
 * The live court answers only what the mirror cannot: the three NALUS fields
 * it never downloaded (populární název, napadený akt, napadený orgán), two
 * filters whose metadata it holds for part of the decisions only (NSS oblast
 * úpravy, ÚS "published in a Sbírka" — see the specs below), a decision it
 * does not hold (yet), the CJEU — and an outage.
 * Search operators (AND / OR / NOT, NEAR, prefix*, brackets) are NOT among
 * those: the mirror reads them itself (src/mirror/api/boolean.ts) — the
 * Czech courts are answered from the mirror whenever it can answer.
 *
 * Answers are text only (the wrapper strips structuredContent anyway), in
 * the live tools' line format, and every hit names the same *_get_* call —
 * the ids are the courts' own, so either backend can read it.
 */

export type ToolText = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
export type MirrorAnswer = ToolText | { fallback: string };
type Args = Record<string, unknown>;
/** The live tool of the same name, for the part of a call the mirror does not hold (the CJEU lane). */
export type LiveCall = (args: Args) => Promise<Record<string, unknown>>;


/** One short line: it heads every answer from the mirror, a dozen times in one research. */
export const MIRROR_NOTE = "[Dawmain mirror: nightly copy of NS, NSS, ÚS and justice.cz — the last day may be missing.]";

/** What a hit line's facts mean — once per list, under the hits. */
export const HIT_LEGEND =
  "(str. = pages of the whole text: ask for all of them in one turn. cit. = mirrored decisions citing it. The link to cite comes with caselaw_get_decision.)";

/** The call that reads a hit — one tool for the four sources (./caselaw-get.ts). */
export function readCall(source: MirrorCourt, id: string): string {
  return `caselaw_get_decision source: ${source}, id: ${id}`;
}

const FORM: Record<string, string> = {
  rozsudek: "rozsudek",
  usneseni: "usnesení",
  nalez: "nález",
  stanovisko: "stanovisko",
  jine: "jiné",
};

function text(lines: string[], isError = false): ToolText {
  return { content: [{ type: "text", text: lines.join("\n") }], ...(isError ? { isError: true } : {}) };
}

/** Unset = what the schema's default leaves: nothing, false, [] or the given default. */
function isSet(value: unknown, fallback?: unknown): boolean {
  if (value === undefined || value === null || value === false || value === "") return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return value !== fallback;
}

/** The first parameter the mirror cannot honour, as the fallback reason; null = all fine. */
function unsupported(args: Args, handled: readonly string[], defaults: Record<string, unknown> = {}): string | null {
  for (const [key, value] of Object.entries(args)) {
    if (handled.includes(key)) continue;
    if (isSet(value, defaults[key])) return `the mirror has no "${key}" filter`;
  }
  return null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Characters of the passage a hit line carries. */
const BRIEF_CHARS = 220;

/** A marked word as the comparison sees it: the same stem in two cases counts once. */
function termKey(word: string): string {
  return word.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().slice(0, 5);
}

/**
 * The hit's passage in one line: the stretch of the mirror's excerpt that
 * holds the most DIFFERENT query words (the first such stretch on a tie). A
 * hit line used to say which decision it is and nothing of what it says, so
 * telling a relevant hit from a stray one meant opening it (15–45k
 * characters). Cutting around the first marked word showed whatever came
 * first — "všech «bytem» XY" from the parties' addresses while the passage on
 * «výpověď» z «nájmu» «bytu» sat further on in the same excerpt. Cut at word
 * boundaries. Pure — exported for the tests.
 */
export function briefExcerpt(hit: Pick<MirrorHit, "excerpt" | "highlights">, max = BRIEF_CHARS): string {
  const marked = markedExcerpt(hit);
  if (marked.length <= max) return marked;
  const marks = [...marked.matchAll(/«([^»]*)»/g)].map((m) => ({ at: m.index, end: m.index + m[0].length, key: termKey(m[1]) }));
  const lead = Math.floor(max / 4);
  let best = Math.max(0, (marks[0]?.at ?? 0) - lead);
  let bestScore = 0;
  for (const mark of marks) {
    const from = Math.max(0, mark.at - lead);
    const score = new Set(marks.filter((m) => m.at >= from && m.end <= from + max).map((m) => m.key)).size;
    if (score > bestScore) {
      bestScore = score;
      best = from;
    }
  }
  let start = best;
  if (start > 0) start = marked.indexOf(" ", start) + 1 || start;
  let end = Math.min(marked.length, start + max);
  if (end < marked.length) end = Math.max(marked.lastIndexOf(" ", end), start + Math.floor(max / 2));
  return `${start > 0 ? "…" : ""}${marked.slice(start, end).trim()}${end < marked.length ? "…" : ""}`;
}

/**
 * The court, where the tag and the spisová značka do not already say it: the
 * lane's own court goes without saying ("[NS] … — Nejvyšší soud" told nothing,
 * forty characters a hit), a rozšířený senát, a krajský soud in the NSS index
 * and every obecný soud are named. Pure — exported for the tests.
 */
export function courtLabel(hit: { source: MirrorCourt; court: string | null }): string | null {
  const court = hit.court?.trim();
  if (!court) return null;
  if (hit.source === "ns" && /^Nejvyšší soud\b/i.test(court)) return null;
  if (hit.source === "us") return null;
  if (hit.source === "nss" && /^Nejvyšší správní soud/i.test(court)) {
    return /rozšířen|RS NSS/i.test(court) ? "rozšířený senát" : null;
  }
  return court;
}

/** "1 str." / "~3 str." — the pages the whole text takes (the pager breaks between paragraphs, hence ~). Pure. */
export function sizeNote(chars: number | null | undefined): string | null {
  if (typeof chars !== "number" || !(chars > 0)) return null;
  const pages = Math.ceil(chars / DOC_PAGE_CHARS);
  return pages <= 1 ? "1 str." : `~${pages} str.`;
}

/** " · ~2 str. · cit. 37×" — what the mirror knows of a decision beside the match; "" from an API that predates it. */
function factsNote(hit: { chars?: number | null; citedBy?: number }): string {
  const parts = [sizeNote(hit.chars), typeof hit.citedBy === "number" && hit.citedBy > 0 ? `cit. ${hit.citedBy}×` : null].filter(Boolean);
  return parts.length ? ` · ${parts.join(" · ")}` : "";
}

/**
 * One hit; `brief` adds its passage (the hits without a read_top preview below
 * the list). No link: the *_get_* call that reads the decision returns it, and
 * a decision is cited only after that call — fifteen links a list were a
 * quarter of its characters.
 */
function hitLine(hit: MirrorHit, index: number, withSource: boolean, brief = false): string {
  const facts = [hit.form ? (FORM[hit.form] ?? hit.form) : null, hit.date].filter(Boolean).join(", ");
  const tag = withSource ? `[${hit.source.toUpperCase()}] ` : "";
  const court = courtLabel(hit);
  const passage = brief && hit.excerpt ? `\n   ${hit.inDissent ? "(odlišné stanovisko) " : ""}${briefExcerpt(hit)}` : "";
  return `${index + 1}. ${tag}${hit.caseNumber ?? "?"}${hit.category ? ` [${hit.category}]` : ""}${facts ? ` (${facts})` : ""}${court ? ` — ${court}` : ""}${factsNote(hit)} → ${readCall(hit.source, hit.id)}${passage}`;
}

function previewLines(hits: MirrorHit[], readTop: number, withSource: boolean): string[] {
  const shown = hits.slice(0, readTop).filter((hit) => hit.excerpt);
  if (!shown.length) return [];
  return [
    "",
    ...shown.map(
      (hit) =>
        `── ${withSource ? `[${hit.source.toUpperCase()}] ` : ""}${hit.caseNumber ?? hit.id}${hit.inDissent ? " (in an odlišné stanovisko)" : ""}\n${markedExcerpt(hit)}`,
    ),
  ];
}

/** What a variant found: its hits, and whether any decision held ALL its words ("or" = none did). */
interface VariantCount {
  hits: number;
  anyWord: boolean;
}

/** "5 · 5 any-word · ✗" — per variant, in the order searched. */
function perVariantNote(perVariant: Array<VariantCount | null>): string {
  return perVariant.map((v) => (v === null ? "✗" : `${v.hits}${v.anyWord && v.hits ? " any-word" : ""}`)).join(" · ");
}

/**
 * The line that says what the count is worth. The mirror returns the best
 * `limit` and no total, so a full list means "at least"; and when no decision
 * holds every word of a variant the mirror ranks by how many it holds — hits
 * that share one common word with the question. The reader has to know, or it
 * reads fifteen strays as the case law.
 */
function countNote(shown: number, limit: number, perVariant: Array<VariantCount | null>): string {
  const answered = perVariant.filter((v): v is VariantCount => v !== null);
  const full = shown >= limit ? `the best ${shown} (there may be more — narrow rather than page)` : `${shown}`;
  const allAnyWord = shown > 0 && answered.length > 0 && answered.every((v) => v.anyWord || !v.hits);
  return `${full}${allAnyWord ? " ⚠ no decision holds ALL the words — these hold SOME; use fewer, more distinctive words or a \"phrase\"" : ""}`;
}

/**
 * A query no court could be asked either: its operators do not parse (an
 * unclosed bracket, a NOT with nothing to find). The mirror says what is wrong;
 * that goes back to the caller as the answer — sent on to the live court, the
 * NS box guessed at the expression and answered something the reader never
 * asked (measured 11/2026: `nájem AND (výpověď` → "≥1000 matches").
 */
export class QuerySyntaxError extends Error {}
const UNREADABLE = "the query could not be read: ";

/** The mirror's reason when it refused the query's own syntax, else null. */
function syntaxReason(error: unknown): string | null {
  return error instanceof MirrorRefusal && error.status === 400 && error.reason.startsWith(UNREADABLE) ? error.reason.slice(UNREADABLE.length) : null;
}

function syntaxAnswer(error: QuerySyntaxError): ToolText {
  return text(
    [
      `The query could not be read — ${error.message}.`,
      'Operators are AND, OR, NOT, NEAR, SENTENCE, PARAGRAPH in capitals, brackets in pairs, a prefix as word* (three letters or more), a "phrase" in quotation marks; NOT needs something to find beside it. Correct the expression and call again.',
    ],
    true,
  );
}

/** Every variant searched, merged round-robin (as the live tools do). */
async function searchVariants(
  variants: string[],
  base: Omit<MirrorSearchParams, "q">,
): Promise<{ hits: MirrorHit[]; failures: string[]; perVariant: Array<VariantCount | null>; total?: number }> {
  const runs = variants.length ? variants : [undefined];
  const settled = await Promise.allSettled(runs.map((q) => searchMirror({ ...base, ...(q ? { q } : {}) })));
  const lists: MirrorHit[][] = [];
  const failures: string[] = [];
  const perVariant: Array<VariantCount | null> = [];
  let total: number | undefined;
  settled.forEach((result, i) => {
    if (result.status === "fulfilled") {
      if (typeof result.value.total === "number") total = result.value.total;
      lists.push(result.value.hits);
      perVariant.push({ hits: result.value.hits.length, anyWord: result.value.channel === "or" });
    } else {
      perVariant.push(null);
      const reason = result.reason instanceof SourceError ? result.reason.message : String(result.reason);
      failures.push(runs[i] ? `variant "${runs[i]}": ${reason}` : reason);
    }
  });
  if (!lists.length) {
    // Nothing answered, and at least one variant because its expression does not parse: that is the
    // reader's to correct, not a reason to ask the court.
    const unreadable = settled.flatMap((result, i) => {
      const reason = result.status === "rejected" ? syntaxReason(result.reason) : null;
      return reason ? [`${runs.length > 1 ? `variant "${runs[i]}": ` : ""}${reason}`] : [];
    });
    if (unreadable.length) throw new QuerySyntaxError(unreadable.join("; "));
    throw new Error(failures.join("; ") || "the mirror did not answer");
  }
  return { hits: interleave(lists, (hit) => `${hit.source}:${hit.id}`), failures, perVariant, ...(total !== undefined ? { total } : {}) };
}

// ── decisions citing one provision ──────────────────────────────────────────

/** Characters of the text around the citation that a provision hit carries. */
const PROVISION_BRIEF_CHARS = 260;

function provisionLine(hit: MirrorProvisionHit, index: number, withSource: boolean): string {
  const facts = [hit.form ? (FORM[hit.form] ?? hit.form) : null, hit.date].filter(Boolean).join(", ");
  const tag = withSource ? `[${hit.source.toUpperCase()}] ` : "";
  const court = courtLabel(hit);
  const names = hit.mentions > 1 ? ` · names the provision ${hit.mentions}×` : "";
  const excerpt = hit.excerpt.length > PROVISION_BRIEF_CHARS ? `${hit.excerpt.slice(0, hit.excerpt.lastIndexOf(" ", PROVISION_BRIEF_CHARS))}…` : hit.excerpt;
  return `${index + 1}. ${tag}${hit.caseNumber ?? "?"}${hit.category ? ` [${hit.category}]` : ""}${facts ? ` (${facts})` : ""}${court ? ` — ${court}` : ""}${factsNote(hit)}${names} → ${readCall(hit.source, hit.id)}${excerpt ? `\n   …${excerpt}` : ""}`;
}

/** What the mirror is asked for: an act id with a provision, or a whole citation it reads itself. */
export type ProvisionRequest = { act: string; provision: string } | { cite: string };

const ARTICLE_WORD = /^\s*(?:článku|článek|čl\.?|article|art\.?)\s*/i;
/** Acts divided into články, by how the caller names them. */
const ARTICLE_ACT = /nařízení|směrnic|rozhodnutí|smlouv|úmluv|listin|ústav|charter|gdpr|s?feu|\bseu\b|eúlp|brusel|řím/i;
const EU_KIND = /(nařízení|směrnic\p{L}*|rozhodnutí)/iu;

/**
 * How one provision of one act is put to the mirror — the index holds Czech
 * acts (zak:89/2012), international treaties (sm:…) and EU law (CELEX; the
 * treaties and the Charter by name), and decisions cite all of them.
 *
 *  - číslo/rok of the Sbírka ("89/2012", "sm:12/2005") and a CELEX number
 *    ("32016R0679") are ids: sent as act + provision.
 *  - anything else — "GDPR", "SFEU", "Listina EU", "Úmluva", "o. z.",
 *    "nařízení (EU) 2016/679", "směrnice 2004/48/ES" — is a citation the
 *    mirror reads with its own parser and registry of names: sent as cite.
 *
 * "2016/1148" is NOT číslo/rok: read as act 2016 of the year 1148 it found
 * nothing, without a word. An EU number since 2015 written without "(EU)" gets
 * it ("nařízení 2016/679" → "nařízení (EU) 2016/679" — the parser reads only
 * the official form); with no kind named, the act cannot be told (regulations
 * and directives share one numbering) and the call is refused with the forms
 * that work. A provision without § / čl. takes the mark its act uses.
 * Returns the refusal as a string. Pure — exported for the tests.
 */
export function provisionRequest(actRaw: string, provisionRaw: string): ProvisionRequest | string {
  const act = actRaw.trim().replace(/\s+/g, " ");
  const bare = provisionRaw.trim().replace(/\s+/g, " ");
  const marked = /^\s*§/.test(bare) ? bare : ARTICLE_WORD.test(bare) ? bare.replace(ARTICLE_WORD, "čl. ") : null;
  const withMark = (article: boolean) => marked ?? `${article ? "čl." : "§"} ${bare}`;

  const celex = /^(?:eu:)?([0-9]{5}[A-Z]{1,2}(?:[0-9]{4}|\/TXT))$/i.exec(act);
  if (celex) return { act: `eu:${celex[1].toUpperCase()}`, provision: withMark(true) };
  const sbirka = /^(zak:|sm:)?(\d{1,4})\/(\d{4})(?:\s*Sb\.(?:\s*m\.\s*s\.)?)?$/i.exec(act);
  if (sbirka) {
    const year = Number(sbirka[3]);
    if (year >= 1918 && year <= 2100) {
      const prefix = (sbirka[1] ?? (/m\.\s*s\./i.test(act) ? "sm:" : "")).toLowerCase();
      return { act: `${prefix}${Number(sbirka[2])}/${sbirka[3]}`, provision: withMark(prefix === "sm:") };
    }
  }
  const euNumber = /\b((?:19|20)\d{2})\/(\d{1,4})\b/.exec(act);
  if (euNumber && !EU_KIND.test(act)) {
    return `"${act}" does not say which act it is. Pass the Sbírka number as číslo/rok ("89/2012"), or an EU act with its kind or CELEX number: "nařízení (EU) 2016/679", "směrnice 2004/48/ES", "32016R0679" — or a name the courts use: "GDPR", "SFEU", "Listina EU", "Úmluva".`;
  }
  // Since 2015 EU acts are numbered "(EU) rok/číslo"; the parser reads the official form only.
  const official =
    euNumber && Number(euNumber[1]) >= 2015 && !/\((?:EU|ES|EHS|Euratom)[^)]*\)/i.test(act) && !/\/(?:EU|ES|EHS)\b/i.test(act)
      ? act.replace(EU_KIND, "$1 (EU)")
      : act;
  return { cite: `${withMark(ARTICLE_ACT.test(act))} ${official}` };
}

/**
 * One court's decisions citing a provision — the most cited first where the
 * mirror can order them so; when that query runs out of time (a provision
 * cited by thousands), newest first. Any other refusal is the caller's.
 */
async function provisionLane(
  court: MirrorCourt,
  base: ProvisionRequest & { from?: string; to?: string; limit: number; offset?: number },
  sort: "cited" | "newest",
): Promise<MirrorProvisionResult> {
  try {
    return await mirrorProvisions({ ...base, sources: [court], sort });
  } catch (error) {
    if (sort === "cited" && error instanceof MirrorRefusal && error.status === 504) {
      return mirrorProvisions({ ...base, sources: [court], sort: "newest" });
    }
    throw error;
  }
}

function orderNote(result: MirrorProvisionResult, asked: "cited" | "newest"): string {
  if (result.sortedBy === "cited") return "most cited first";
  return asked === "cited" && result.total > result.hits.length ? "newest first (too many to order by citations — narrow with dates)" : "newest first";
}

/** The provision as it was asked for, with the act's id as the mirror resolved it — the reader sees which act was searched. */
function provisionName(request: ProvisionRequest, resolved?: MirrorProvisionResult): string {
  const asked = "cite" in request ? request.cite : `${request.provision} of ${request.act}`;
  const id = resolved?.act && "cite" in request ? ` (${resolved.act.replace(/^zak:/, "").replace(/^eu:/, "CELEX ")})` : "";
  return `${asked}${id}`;
}

const PROVISION_FORMS =
  'applies_act takes the Sbírka number ("89/2012"), a CELEX number ("32016R0679"), or the act as the courts cite it ("nařízení (EU) 2016/679", "směrnice 2004/48/ES", "GDPR", "SFEU", "Listina EU", "Úmluva", "o. z."); applies_provision "§ 2291", "§ 2291 odst. 2" or "čl. 6 odst. 1".';

/** applies_act + applies_provision on caselaw_search: the top courts' decisions citing that provision, court by court. */
async function caselawByProvision(args: Args, act: string | undefined, provision: string | undefined): Promise<MirrorAnswer> {
  if (!act || !provision) {
    return text(
      [
        `applies_act and applies_provision go together — one provision of one act. ${PROVISION_FORMS}`,
      ],
      true,
    );
  }
  const from = str(args.date_from);
  const to = str(args.date_to);
  const inverted = dateRangeError(from, to);
  if (inverted) return text([inverted], true);
  const request = provisionRequest(act, provision);
  if (typeof request === "string") return text([request], true);
  const requested = Array.isArray(args.sources) && args.sources.length ? (args.sources as string[]) : null;
  const lanes = CASELAW_LANES.filter((lane) => (requested ? requested.includes(lane) : true));
  if (!lanes.length) return text(["applies_act / applies_provision search the Czech courts (nss, ns, us) — also for EU law, as those courts cite it; the CJEU's own case law is searched with sdeu_search."], true);
  const limit = Math.min(10, Math.max(1, num(args.per_source_limit, 5)));
  const settled = await Promise.all(
    lanes.map(async (lane) => {
      try {
        return { lane, ok: true as const, result: await provisionLane(lane, { ...request, from, to, limit }, "cited") };
      } catch (error) {
        return { lane, ok: false as const, error };
      }
    }),
  );
  // A provision the mirror cannot read is the same refusal from every lane: say it once, as an input error.
  const refusal = settled.find((lane) => !lane.ok && lane.error instanceof MirrorRefusal && lane.error.status === 400);
  if (refusal && !refusal.ok) return text([`${(refusal.error as MirrorRefusal).message} ${PROVISION_FORMS}`], true);
  if (settled.every((lane) => !lane.ok)) {
    return text(
      [
        `The mirror did not answer (${settled.map((lane) => (lane.ok ? "" : lane.error instanceof Error ? lane.error.message : String(lane.error))).join("; ")}).`,
        `Meanwhile: put the provision into the query as a phrase (query: '"§ 2291" …'), or use nss_search / justice_search with their own applies_act.`,
      ],
      true,
    );
  }
  const statusLines = settled.map((lane) => {
    if (!lane.ok) return `✗ ${lane.lane.toUpperCase()}: ${lane.error instanceof Error ? lane.error.message : String(lane.error)}`;
    const scope = lane.lane === "nss" ? " — the NSS index, krajské soudy included" : "";
    return `✓ ${lane.lane.toUpperCase()}: ${lane.result.total} decision${lane.result.total === 1 ? "" : "s"} cite it — ${orderNote(lane.result, "cited")}${scope}`;
  });
  const items: MirrorProvisionHit[] = [];
  for (let rank = 0; rank < limit; rank++) {
    for (const lane of settled) if (lane.ok && lane.result.hits[rank]) items.push(lane.result.hits[rank]);
  }
  return text([
    MIRROR_NOTE,
    `Decisions citing ${provisionName(request, settled.find((lane) => lane.ok)?.result)}${from || to ? ` (decided ${from ?? "…"} – ${to ?? "…"})` : ""}:`,
    ...statusLines,
    // The CJEU is not in the index of cited provisions: say so rather than leave its lane out unmentioned.
    ...((requested ? requested.includes("sdeu") : args.include_eu === true)
      ? ["– SDEU: not searched by provision — the CJEU's own case law: sdeu_search with the words of the provision."]
      : []),
    "",
    ...(items.length ? items.map((hit, i) => provisionLine(hit, i, true)) : ["No mirrored decision of these courts cites it — check the act and the provision, or search the provision as a phrase in the query."]),
    ...(items.length ? ["", HIT_LEGEND] : []),
  ]);
}

// ── caselaw_search ──────────────────────────────────────────────────────────

const CASELAW_LANES: MirrorCourt[] = ["nss", "ns", "us"];

/** The text of a live tool's answer, or null when it failed or carried none. */
function liveText(result: Record<string, unknown> | null): string | null {
  if (!result || result.isError) return null;
  const parts = Array.isArray(result.content) ? (result.content as Array<{ type?: string; text?: string }>) : [];
  const joined = parts.map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : "")).join("\n").trim();
  return joined || null;
}

async function caselawSearch(args: Args, live?: LiveCall): Promise<MirrorAnswer> {
  const act = str(args.applies_act);
  const provision = str(args.applies_provision);
  const variants = uniqueQueries(str(args.query), args.queries as string[] | undefined);
  // The provision alone: each court's decisions citing it, the most cited first. With words beside
  // it, it is a filter of the search — the words are looked for among the decisions citing it.
  if ((act || provision) && !variants.length) return caselawByProvision(args, act, provision);
  let applies: Partial<MirrorSearchParams> = {};
  if (act || provision) {
    if (!act || !provision) return text([`applies_act and applies_provision go together — one provision of one act. ${PROVISION_FORMS}`], true);
    const request = provisionRequest(act, provision);
    if (typeof request === "string") return text([request], true);
    applies = request;
  }
  if (!variants.length) return { fallback: "no query" };
  const from = str(args.date_from);
  const to = str(args.date_to);
  if (dateRangeError(from, to)) return { fallback: "inverted date range" };
  const requested = Array.isArray(args.sources) && args.sources.length ? (args.sources as string[]) : null;
  const wantsEu = requested ? requested.includes("sdeu") : args.include_eu === true;
  // The CJEU is not mirrored: a call that is about it alone goes live whole.
  const lanes = CASELAW_LANES.filter((lane) => (requested ? requested.includes(lane) : true));
  if (!lanes.length) return { fallback: "the mirror does not hold the CJEU" };
  const limit = Math.min(10, Math.max(1, num(args.per_source_limit, 5)));
  const readTop = Math.min(3, Math.max(0, num(args.read_top, 0)));
  // The CJEU is not mirrored: its lane is asked of the court itself, alongside the mirror's lanes, so
  // include_eu still means one call (it used to answer "search it with sdeu_search" — a round of its own).
  const cjeu = wantsEu && live ? live({ ...args, sources: ["sdeu"], include_eu: true }).catch(() => null) : null;

  const settled = await Promise.all(
    lanes.map(async (lane) => {
      try {
        const run = await searchVariants(variants, {
          sources: [lane],
          from,
          to,
          regional: lane === "nss" && args.include_regional === true,
          limit,
          ...applies,
        });
        return { lane, ok: true as const, ...run, hits: run.hits.slice(0, limit) };
      } catch (error) {
        return { lane, ok: false as const, error: error instanceof Error ? error.message : String(error), syntax: error instanceof QuerySyntaxError ? error : undefined };
      }
    }),
  );
  // The same expression failed to parse in every lane: one answer saying what is wrong with it.
  const unreadable = settled.find((lane) => !lane.ok && lane.syntax);
  if (unreadable && !unreadable.ok && unreadable.syntax && settled.every((lane) => !lane.ok)) return syntaxAnswer(unreadable.syntax);
  if (settled.every((lane) => !lane.ok)) {
    return { fallback: `the mirror did not answer (${settled.map((lane) => (lane.ok ? "" : lane.error)).join("; ")})` };
  }
  const statusLines = settled.map((lane) => {
    if (!lane.ok) return `✗ ${lane.lane.toUpperCase()}: ${lane.error} — retry with ${lane.lane}_search`;
    const per = variants.length > 1 ? ` (per variant: ${perVariantNote(lane.perVariant)})` : "";
    const scope = lane.lane === "nss" ? (args.include_regional === true ? " — NSS + krajské soudy" : " — NSS only") : "";
    return `✓ ${lane.lane.toUpperCase()}: ${countNote(lane.hits.length, limit, lane.perVariant)}${per}${scope}${lane.failures.length ? ` ⚠ ${lane.failures.join("; ")}` : ""}`;
  });
  const items: MirrorHit[] = [];
  for (let rank = 0; rank < limit; rank++) {
    for (const lane of settled) if (lane.ok && lane.hits[rank]) items.push(lane.hits[rank]);
  }
  const cjeuText = cjeu ? liveText(await cjeu) : null;
  return text([
    MIRROR_NOTE,
    `Variants searched in parallel: ${variants.map((v) => `"${v}"`).join(", ")}${act && provision ? ` — among the decisions citing ${"cite" in applies ? applies.cite : `${applies.provision} of ${applies.act}`}` : ""}`,
    ...statusLines,
    ...(wantsEu && !cjeuText ? ["– SDEU: did not answer just now — search it with sdeu_search."] : []),
    "",
    ...(items.length ? items.map((hit, i) => hitLine(hit, i, true, i >= readTop)) : ["No hits in the mirror — broaden the query or add variants."]),
    ...previewLines(items, readTop, true),
    ...(items.length ? ["", HIT_LEGEND] : []),
    ...(cjeuText ? ["", "── SDEU — answered live by the court (its own numbering; read with sdeu_get_document):", cjeuText] : []),
  ]);
}

// ── per-court search tools ──────────────────────────────────────────────────

/** One page of a court's list: its size, the hits before it, and the call that asks for the next. */
interface PageSpec {
  limit: number;
  offset: number;
  next: (shown: number) => string;
}

interface CourtSearchSpec {
  court: MirrorCourt;
  /**
   * Parameters the mirror answers. Anything else that is set sends the call to
   * the live court — only for what the mirror holds no data for at all (the
   * NALUS číselník fields: populární název, napadený akt, napadený orgán).
   */
  handled: readonly string[];
  defaults: Record<string, unknown>;
  /** Mirror parameters from the call; a string = fall back with that reason; a ToolText = the answer (an input error). */
  extra?: (args: Args) => Partial<MirrorSearchParams> | string | ToolText;
  page: (args: Args) => PageSpec;
}

const COMMON = ["query", "queries", "case_number", "date_from", "date_to", "published_from", "published_to", "read_top", "limit"];

const NS_CATEGORIES = /^[A-E]$/;
const NS_TYPES: Record<string, string> = { rozsudek: "rozsudek", usnesení: "usneseni", stanovisko: "stanovisko" };
const US_TYPES: Record<string, string> = { nález: "nalez", usnesení: "usneseni", stanovisko: "stanovisko" };
/** justice.cz document types as the mirror stores the form (a trestní příkaz is among "jiné"). */
const JUSTICE_TYPES: Record<string, string> = { JUDGEMENT: "rozsudek", RESOLUTION: "usneseni", ORDER_T: "jine" };
const NSS_COURTS: Record<string, MirrorSearchParams["courtClass"]> = { nss: "nss", "rozsireny-senat": "rozsireny", krajske: "krajske", karne: "karne" };
const JUSTICE_MATCH: Record<string, MirrorSearchParams["match"]> = { all_words: "all", any_word: "any", phrase: "phrase" };

/**
 * The CELEX id of an EU act from the number the courts write: "2016/679",
 * "1049/2001" (a regulation before 2015 is number/year), "2004/48/ES". The
 * four-digit part that can be a year of the Communities is the year; when
 * both can (2015/2283), the first is — the form in use since 2015 and the
 * only one directives ever had. null = not a number of that shape. Pure —
 * exported for the tests.
 */
export function euCelex(kind: "R" | "L", value: string): string | null {
  const m = /^\s*(\d{1,4})\s*\/\s*(\d{1,4})\b/.exec(value);
  if (!m) return null;
  const isYear = (n: string): boolean => n.length === 4 && Number(n) >= 1958 && Number(n) <= 2100;
  // "95/46": acts of the last century carry a two-digit year first.
  const short = m[1].length === 2 && Number(m[1]) >= 58 ? `19${m[1]}` : null;
  const [year, number] = isYear(m[1]) ? [m[1], m[2]] : isYear(m[2]) ? [m[2], m[1]] : short ? [short, m[2]] : [null, null];
  if (!year || !number) return null;
  return `3${year}${kind}${number.padStart(4, "0")}`;
}

/**
 * "17(2)(a)" → "17 odst. 2 písm. a)" — the compact form nss_search takes for a
 * provision; anything else as it is. Pure.
 */
function expandCompactProvision(value: string): string {
  const m = /^\s*(\d+[a-z]?)\s*(?:\((\d+)\))?\s*(?:\(([a-z]{1,2})\))?\s*$/i.exec(value);
  if (!m || (!m[2] && !m[3])) return value.trim();
  return `${m[1]}${m[2] ? ` odst. ${m[2]}` : ""}${m[3] ? ` písm. ${m[3]})` : ""}`;
}

/** The provision with the mark its act uses, when the caller gave none. */
function markedProvision(value: string, article: boolean): string {
  const text = expandCompactProvision(value);
  if (/^\s*§/.test(text)) return text;
  if (ARTICLE_WORD.test(text)) return text.replace(ARTICLE_WORD, "čl. ");
  return `${article ? "čl." : "§"} ${text}`;
}

/**
 * nss_search's applies_* filters as the mirror's cited-provision filter. The
 * NSS form names the applied act by its kind (a Sb. act, a treaty, an EU
 * regulation or directive); the mirror indexes every act a decision cites
 * under one id. A treaty is in the Sbírka mezinárodních smluv since 2000 and
 * in the Sbírka zákonů before (the Úmluva: 209/1992 Sb.).
 */
function nssApplies(args: Args): Partial<MirrorSearchParams> | string {
  const given = (["applies_act", "applies_treaty", "applies_eu_regulation", "applies_eu_directive"] as const).filter((key) => str(args[key]));
  const provision = str(args.applies_provision);
  if (!given.length) return provision ? "applies_provision without an applies_* act" : {};
  if (given.length > 1) return "several applies_* filters at once";
  const key = given[0];
  const value = str(args[key]) as string;
  let act: string | null;
  if (key === "applies_eu_regulation") act = euCelex("R", value);
  else if (key === "applies_eu_directive") act = euCelex("L", value);
  else {
    const m = /^\s*(\d{1,4})\s*\/\s*(\d{4})\b/.exec(value);
    act = m ? `${key === "applies_treaty" && Number(m[2]) >= 2000 ? "sm:" : ""}${Number(m[1])}/${m[2]}` : null;
  }
  if (!act) return `the mirror could not read ${key}: "${value}"`;
  return { act, ...(provision ? { provision: markedProvision(provision, key !== "applies_act") } : {}) };
}

const COURT_SEARCH: Record<string, CourtSearchSpec> = {
  ns_search: {
    court: "ns",
    handled: [...COMMON, "offset", "category", "type", "court"],
    defaults: {},
    page: (args) => {
      const limit = Math.min(50, Math.max(1, num(args.limit, 20)));
      const offset = Math.max(0, num(args.offset, 0));
      return { limit, offset, next: (shown) => `offset: ${offset + shown}` };
    },
    extra: (args) => {
      const category = str(args.category)?.toUpperCase();
      if (category && !NS_CATEGORIES.test(category)) return "unknown NS category";
      const type = str(args.type);
      if (type && !NS_TYPES[type]) return `unknown type ${type}`;
      const court = str(args.court);
      return {
        ...(category ? { categories: [category] } : {}),
        ...(type ? { type: NS_TYPES[type] } : {}),
        ...(court ? { court } : {}),
      };
    },
  },
  nss_search: {
    court: "nss",
    // `area` (oblast úpravy) is not here yet: the mirror reads it from the court's own metadata, which it
    // holds for 86 % of the NSS decisions only (11/2026: those fetched before the column existed lack it,
    // though the raw pages are stored). Until that is rebuilt a search by area would silently miss the rest.
    handled: [...COMMON, "page", "court", "registry", "applies_act", "applies_treaty", "applies_eu_regulation", "applies_eu_directive", "applies_provision"],
    defaults: {},
    page: (args) => {
      const page = Math.max(1, num(args.page, 1));
      return { limit: 20, offset: (page - 1) * 20, next: () => `page: ${page + 1}` };
    },
    extra: (args) => {
      const court = str(args.court);
      if (court && !NSS_COURTS[court]) return `unknown court ${court}`;
      const applies = nssApplies(args);
      if (typeof applies === "string") return applies;
      const registry = str(args.registry);
      return {
        // A class of the NSS index is asked for by name; without one the search is the NSS itself.
        ...(court ? { courtClass: NSS_COURTS[court], regional: true } : {}),
        ...(registry ? { registry } : {}),
        ...applies,
      };
    },
  },
  us_search: {
    court: "us",
    // `only_published` is not here yet: whether a decision is in a Sbírka stands in NALUS's citation line,
    // which the mirror holds for a few hundred decisions only (same cause as the NSS `area`).
    handled: [...COMMON, "page", "sort", "types", "ecli", "include_dissents"],
    defaults: {},
    page: (args) => {
      const page = Math.max(0, num(args.page, 0));
      return { limit: 20, offset: page * 20, next: () => `page: ${page + 1}` };
    },
    extra: (args) => {
      const types = Array.isArray(args.types) ? (args.types as string[]) : [];
      const unknown = types.find((type) => !US_TYPES[type]);
      if (unknown) return `unknown type ${unknown}`;
      const ecli = str(args.ecli);
      return {
        sort: args.sort === "relevance" ? ("relevance" as const) : ("newest" as const),
        ...(types.length ? { types: types.map((type) => US_TYPES[type]) } : {}),
        // An ECLI names one decision, like its spisová značka.
        ...(ecli ? { ownCase: ecli } : {}),
        // include_dissents: the mirror's text of a decision holds its odlišná stanoviska, and a hit
        // found in one says so — there is nothing to switch on.
      };
    },
  },
  justice_search: {
    court: "justice",
    handled: [...COMMON, "page", "sort", "court_codes", "match", "types", "applies_act", "applies_section"],
    defaults: {},
    page: (args) => {
      const limit = Math.min(50, Math.max(1, num(args.limit, 20)));
      const page = Math.max(0, num(args.page, 0));
      return { limit, offset: page * limit, next: () => `page: ${page + 1}` };
    },
    extra: (args) => {
      let courtCodes: string[];
      try {
        // An unknown code answers with the whole list, as live: the mirror would find nothing for it.
        courtCodes = [...new Set((Array.isArray(args.court_codes) ? (args.court_codes as unknown[]) : []).map((code) => justiceCourtCode(String(code))))];
      } catch (error) {
        if (!(error instanceof SourceError)) throw error;
        const { content, isError } = toToolError(error);
        return { content, isError };
      }
      const types = Array.isArray(args.types) ? (args.types as string[]) : [];
      const unknown = types.find((type) => !JUSTICE_TYPES[type]);
      if (unknown) return `unknown type ${unknown}`;
      const match = str(args.match);
      if (match && !JUSTICE_MATCH[match]) return `unknown match ${match}`;
      const act = str(args.applies_act);
      const section = str(args.applies_section);
      if (section && !act) return text(["applies_section needs applies_act (číslo/rok, e.g. '89/2012')."], true);
      let applies: Partial<MirrorSearchParams> = {};
      if (act && section) {
        const request = provisionRequest(act, section);
        if (typeof request === "string") return text([request], true);
        applies = request;
      } else if (act) {
        applies = { act };
      }
      return {
        // With words the list is by relevance; without, newest first — by the day of publication
        // (the live tool's default) or of the decision.
        sort: str(args.query) || (Array.isArray(args.queries) && args.queries.length) ? ("relevance" as const) : ("newest" as const),
        newestBy: args.sort === "decided" ? ("decided" as const) : ("published" as const),
        ...(courtCodes.length ? { courtCodes } : {}),
        ...(types.length ? { types: [...new Set(types.map((type) => JUSTICE_TYPES[type]))] } : {}),
        ...(match && JUSTICE_MATCH[match] !== "all" ? { match: JUSTICE_MATCH[match] } : {}),
        ...applies,
      };
    },
  },
};

/**
 * case_number alone (or an ÚS ecli) = THAT decision, as the live tools match
 * it field by field: /v1/by-case lists the decisions carrying the značka as
 * their own — several where one case has more decisions — where
 * /v1/search?case= would find every decision whose text names it (measured:
 * 26 Cdo 4249/2016, 1 As 113/2012: twenty citing decisions, the decision
 * itself not among them). With words or filters beside it the značka becomes
 * the search's own_case filter (courtSearch). A značka the mirror does not
 * hold goes to the court: a decision of the last day is there first.
 */
async function byCaseNumber(court: MirrorCourt, caseNumber: string, limit: number): Promise<MirrorAnswer> {
  let found: MirrorLinkedDecision[];
  try {
    found = await mirrorDecisionsByCase(caseNumber, [court]);
  } catch (error) {
    return { fallback: `the mirror did not answer (${error instanceof Error ? error.message : String(error)})` };
  }
  if (!found.length) return { fallback: `the mirror holds no ${court.toUpperCase()} decision with the spisová značka "${caseNumber}"` };
  const shown = found.slice(0, limit);
  return text([
    MIRROR_NOTE,
    `${court.toUpperCase()} in the mirror: ${shown.length} decision${shown.length === 1 ? "" : "s"} with the spisová značka "${caseNumber}" as ${shown.length === 1 ? "its" : "their"} own (the decisions citing it: caselaw_citations).`,
    "",
    ...shown.map((d, i) => {
      const facts = [d.form ? (FORM[d.form] ?? d.form) : null, d.date].filter(Boolean).join(", ");
      const named = courtLabel({ source: court, court: d.court });
      return `${i + 1}. ${d.caseNumber ?? caseNumber}${facts ? ` (${facts})` : ""}${named ? ` — ${named}` : ""}${factsNote(d)} → ${readCall(court, d.id)}`;
    }),
    ...(shown.some((d) => factsNote(d)) ? ["", HIT_LEGEND] : []),
  ]);
}

async function courtSearch(name: string, args: Args): Promise<MirrorAnswer> {
  const spec = COURT_SEARCH[name];
  const refused = unsupported(args, spec.handled, spec.defaults);
  if (refused) return { fallback: refused };
  const variants = uniqueQueries(str(args.query), args.queries as string[] | undefined);
  const caseNumber = str(args.case_number);
  const extra = spec.extra?.(args) ?? {};
  if (typeof extra === "string") return { fallback: extra };
  if ("content" in extra) return extra;
  const from = str(args.date_from);
  const to = str(args.date_to);
  if (dateRangeError(from, to)) return { fallback: "inverted date range" };
  const publishedFrom = str(args.published_from);
  const publishedTo = str(args.published_to);
  if (dateRangeError(publishedFrom, publishedTo, "published")) return { fallback: "inverted date range" };
  const page = spec.page(args);
  const { sort: _sort, newestBy: _newestBy, ownCase: extraCase, ...filters } = extra;
  const ownCase = caseNumber ?? extraCase;
  const filtered = Boolean(from || to || publishedFrom || publishedTo || Object.keys(filters).length);
  // Nothing to search for and nothing to filter by: the live tool says what a call needs.
  if (!variants.length && !ownCase && !filtered) return { fallback: "no query, spisová značka or filter" };
  if (ownCase && !variants.length && !filtered && page.offset === 0) return byCaseNumber(spec.court, ownCase, page.limit);
  let run;
  try {
    run = await searchVariants(variants, {
      sources: [spec.court],
      from,
      to,
      ...(publishedFrom ? { publishedFrom } : {}),
      ...(publishedTo ? { publishedTo } : {}),
      limit: page.limit,
      ...(page.offset ? { offset: page.offset } : {}),
      ...extra,
      ...(ownCase ? { ownCase } : {}),
    });
  } catch (error) {
    if (error instanceof QuerySyntaxError) return syntaxAnswer(error);
    return { fallback: `the mirror did not answer (${error instanceof Error ? error.message : String(error)})` };
  }
  const hits = run.hits.slice(0, page.limit);
  const readTop = Math.min(3, Math.max(0, num(args.read_top, 0)));
  const first = page.offset + 1;
  const last = page.offset + hits.length;
  // Without words the mirror lists what passes the filters and counts it; with words it returns the best.
  const listing = !variants.length && typeof run.total === "number";
  const head = listing
    ? `${spec.court.toUpperCase()}: ${run.total} decision${run.total === 1 ? "" : "s"}, newest first${hits.length ? ` — ${first}–${last}` : ""}`
    : `${spec.court.toUpperCase()}: ${countNote(hits.length, page.limit, run.perVariant)}${page.offset ? ` — hits ${first}–${last}` : ""}${
        variants.length > 1 ? ` (per variant: ${perVariantNote(run.perVariant)})` : ""
      }`;
  const more = listing ? last < (run.total as number) : hits.length >= page.limit;
  return text([
    MIRROR_NOTE,
    `${head}${run.failures.length ? ` ⚠ ${run.failures.join("; ")}` : ""}`,
    "",
    ...(hits.length
      ? hits.map((hit, i) => hitLine(hit, page.offset + i, false, i >= readTop || listing))
      : [page.offset ? "No further hits — the list ends before this page." : listing ? "No decision in the mirror passes these filters." : "No hits in the mirror — broaden the query or add variants."]),
    ...previewLines(hits, listing ? 0 : readTop, false),
    ...(more && hits.length ? [`More: ${page.next(hits.length)} (same arguments).`] : []),
    ...(hits.length ? ["", HIT_LEGEND] : []),
  ]);
}

// ── *_get_decision ──────────────────────────────────────────────────────────

const COURT_NAMES: Array<[MirrorCourt, string]> = [
  ["us", "ÚS"],
  ["ns", "NS"],
  ["nss", "NSS"],
  ["justice", "obecné soudy"],
];

/** "ÚS 1, NS 4, obecné soudy 32" — who cites a decision, the courts that bind first. Pure. */
export function citedByCourts(bySource: Partial<Record<MirrorCourt, number>>): string {
  return COURT_NAMES.filter(([court]) => bySource[court])
    .map(([court, label]) => `${label} ${bySource[court]}`)
    .join(", ");
}

/**
 * Who cites the decision, in its header: whether the Ústavní soud or a velký
 * senát took it up is asked of every decision an answer rests on, and used to
 * cost a caselaw_citations call each. Pure — exported for the tests.
 */
export function citedByLine(citedBy: MirrorCitedBySummary, court: MirrorCourt, id: string): string {
  if (!citedBy.total) return "Citováno: žádné rozhodnutí v zrcadle je necituje.";
  const top = citedBy.top ? `; of them ${citedBy.top} stanovisko / plénum ÚS / velký senát NS / rozšířený senát NSS` : "";
  return `Citováno: ${citedBy.total}× (${citedByCourts(citedBy.bySource)}${top}) → caselaw_citations source: ${court}, id: ${id}`;
}

/**
 * The decision a spisová značka names, for a read by `case_number`: its id
 * when one decision of that court carries it, the list to choose from when
 * several do (a case with more decisions), null when the mirror holds none.
 * Looking a značka up used to be a call of its own before every read
 * (`ns_search {case_number}` → id → read: six extra calls in three of five
 * test researches, 11/2026).
 */
export async function resolveCaseNumber(court: MirrorCourt, caseNumber: string): Promise<{ id: string } | ToolText | null> {
  const found = await mirrorDecisionsByCase(caseNumber, [court]);
  if (!found.length) return null;
  if (found.length === 1) return { id: found[0].id };
  return text([
    MIRROR_NOTE,
    `${found.length} ${court.toUpperCase()} decisions carry the spisová značka "${caseNumber}" — read the one you mean by its id:`,
    "",
    ...found.map((d, i) => {
      const facts = [d.form ? (FORM[d.form] ?? d.form) : null, d.date].filter(Boolean).join(", ");
      const named = courtLabel({ source: court, court: d.court });
      return `${i + 1}. ${d.caseNumber ?? caseNumber}${facts ? ` (${facts})` : ""}${named ? ` — ${named}` : ""}${factsNote(d)} → ${readCall(court, d.id)}`;
    }),
  ]);
}

async function getDecision(args: Args): Promise<MirrorAnswer> {
  const court = MIRROR_COURTS.find((c) => c === args.source);
  let id = str(args.id);
  // An unknown court or nothing naming the decision: the live tool says what is wrong with the call.
  if (!court) return { fallback: "no source the mirror holds" };
  const caseNumber = str(args.case_number);
  if (!id && caseNumber) {
    let resolved;
    try {
      resolved = await resolveCaseNumber(court, caseNumber);
    } catch (error) {
      return { fallback: `the mirror did not answer (${error instanceof Error ? error.message : String(error)})` };
    }
    if (!resolved) return { fallback: `the mirror holds no ${court.toUpperCase()} decision with the spisová značka "${caseNumber}"` };
    if ("content" in resolved) return resolved;
    id = resolved.id;
  }
  if (!id) return { fallback: "no id" };
  // An ÚS decision named by ECLI: the mirror keys ÚS by sz, the court resolves the ECLI.
  if (court === "us" && /^ECLI:/i.test(id)) return { fallback: "the mirror reads ÚS decisions by sz, not by ECLI" };
  let decision;
  try {
    decision = await getMirrorDecision(court, id);
    // NS UNIDs are hex: the mirror keeps the court's spelling, a model may not.
    if (!decision && court === "ns") {
      const other = id === id.toUpperCase() ? id.toLowerCase() : id.toUpperCase();
      decision = await getMirrorDecision(court, other);
    }
  } catch (error) {
    return { fallback: `the mirror did not answer (${error instanceof Error ? error.message : String(error)})` };
  }
  if (!decision) return { fallback: "the mirror does not hold this decision (yet)" };
  if (!decision.text) return { fallback: "the mirror has no text of this decision" };
  const find = str(args.find);
  const paged = readDecision(decision.text, {
    page: Math.max(1, num(args.page, 1)),
    find,
    paragraphs: str(args.paragraphs),
    outline: args.outline === true,
  });
  const meta = [
    decision.caseNumbers.length ? `Spisová značka: ${decision.caseNumbers.join("; ")}` : decision.caseNumber ? `Spisová značka: ${decision.caseNumber}` : null,
    decision.court ? `Soud: ${decision.court}` : null,
    decision.date ? `Datum rozhodnutí: ${decision.date}` : null,
    decision.form ? `Druh: ${FORM[decision.form] ?? decision.form}` : null,
    decision.category ? `Kategorie: ${decision.category}` : null,
    decision.ecli ? `ECLI: ${decision.ecli}` : null,
    decision.published ? `Zveřejněno: ${decision.published}` : null,
    decision.legalSentence ? `Právní věta: ${decision.legalSentence}` : null,
    decision.citedBy ? citedByLine(decision.citedBy, court, decision.id) : null,
    decision.goneAt ? `⚠ The court no longer publishes this decision (since ${decision.goneAt.slice(0, 10)}).` : null,
    decision.url,
  ].filter(Boolean);
  return text([MIRROR_NOTE, ...(meta as string[]), "", `${paged.text}${continuationHint(paged)}`]);
}

// ── the routing table ───────────────────────────────────────────────────────

export const MIRROR_TOOLS: Record<string, (args: Args, live?: LiveCall) => Promise<MirrorAnswer>> = {
  caselaw_search: caselawSearch,
  ...Object.fromEntries(Object.keys(COURT_SEARCH).map((name) => [name, (args: Args) => courtSearch(name, args)])),
  caselaw_get_decision: getDecision,
};
