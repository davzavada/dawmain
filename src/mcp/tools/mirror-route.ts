import { SourceError } from "@/src/sources/shared/errors";
import { interleave, pageOrExcerpt, uniqueQueries } from "@/src/sources/shared/text";
import {
  getMirrorDecision,
  markedExcerpt,
  searchMirror,
  type MirrorCourt,
  type MirrorHit,
  type MirrorSearchParams,
} from "@/src/sources/mirror";
import { continuationHint, dateRangeError } from "./shared";

/**
 * The case-law tools answered from the home mirror instead of the courts —
 * for an operator who switched "Zdroj judikatury" to Zrcadlo
 * (src/mcp/backend.ts). Same tool names, same parameters: a handler here
 * either answers the call or returns `{ fallback }` with the reason, and the
 * registration wrapper (./index.ts) then runs the live tool, telling the
 * model why. Falls back on what the mirror cannot do: filters it does not
 * index, pages past the first, a decision it does not hold (yet), CJEU.
 *
 * Answers are text only (the wrapper strips structuredContent anyway), in
 * the live tools' line format, and every hit names the same *_get_* call —
 * the ids are the courts' own, so either backend can read it.
 */

export type ToolText = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
export type MirrorAnswer = ToolText | { fallback: string };
type Args = Record<string, unknown>;

export const MIRROR_NOTE =
  "[Source: Dawmain case-law mirror (a copy of NS, NSS, ÚS and rozhodnuti.justice.cz, synced nightly — decisions from the last day may be missing). Ids, links and *_get_* calls are the courts' own.]";

const DETAIL: Record<MirrorCourt, (id: string) => string> = {
  ns: (id) => `ns_get_decision unid: ${id}`,
  nss: (id) => `nss_get_decision document_id: ${id}`,
  us: (id) => `us_get_decision sz: ${id}`,
  justice: (id) => `justice_get_decision uuid: ${id}`,
};

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

function hitLine(hit: MirrorHit, index: number, withSource: boolean): string {
  const facts = [hit.form ? (FORM[hit.form] ?? hit.form) : null, hit.date].filter(Boolean).join(", ");
  const tag = withSource ? `[${hit.source.toUpperCase()}] ` : "";
  return `${index + 1}. ${tag}${hit.caseNumber ?? "?"}${hit.category ? ` [${hit.category}]` : ""}${facts ? ` (${facts})` : ""}${hit.court ? ` — ${hit.court}` : ""} → ${DETAIL[hit.source](hit.id)}\n   ${hit.url}`;
}

function previewLines(hits: MirrorHit[], readTop: number, withSource: boolean): string[] {
  const shown = hits.slice(0, readTop).filter((hit) => hit.excerpt);
  if (!shown.length) return [];
  return [
    "",
    ...shown.map(
      (hit) =>
        `── ${withSource ? `[${hit.source.toUpperCase()}] ` : ""}${hit.caseNumber ?? hit.id}${hit.inDissent ? " (in an odlišné stanovisko)" : ""}\n${markedExcerpt(hit)}\n(whole text: ${DETAIL[hit.source](hit.id)})`,
    ),
  ];
}

/** Every variant searched, merged round-robin (as the live tools do). */
async function searchVariants(
  variants: string[],
  base: Omit<MirrorSearchParams, "q">,
): Promise<{ hits: MirrorHit[]; failures: string[]; perVariant: Array<number | null> }> {
  const runs = variants.length ? variants : [undefined];
  const settled = await Promise.allSettled(runs.map((q) => searchMirror({ ...base, ...(q ? { q } : {}) })));
  const lists: MirrorHit[][] = [];
  const failures: string[] = [];
  const perVariant: Array<number | null> = [];
  settled.forEach((result, i) => {
    if (result.status === "fulfilled") {
      lists.push(result.value.hits);
      perVariant.push(result.value.hits.length);
    } else {
      perVariant.push(null);
      const reason = result.reason instanceof SourceError ? result.reason.message : String(result.reason);
      failures.push(runs[i] ? `variant "${runs[i]}": ${reason}` : reason);
    }
  });
  if (!lists.length) throw new Error(failures.join("; ") || "the mirror did not answer");
  return { hits: interleave(lists, (hit) => `${hit.source}:${hit.id}`), failures, perVariant };
}

// ── caselaw_search ──────────────────────────────────────────────────────────

const CASELAW_LANES: MirrorCourt[] = ["nss", "ns", "us"];

async function caselawSearch(args: Args): Promise<MirrorAnswer> {
  const variants = uniqueQueries(str(args.query), args.queries as string[] | undefined);
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

  const settled = await Promise.all(
    lanes.map(async (lane) => {
      try {
        const run = await searchVariants(variants, {
          sources: [lane],
          from,
          to,
          regional: lane === "nss" && args.include_regional === true,
          limit,
        });
        return { lane, ok: true as const, ...run, hits: run.hits.slice(0, limit) };
      } catch (error) {
        return { lane, ok: false as const, error: error instanceof Error ? error.message : String(error) };
      }
    }),
  );
  if (settled.every((lane) => !lane.ok)) {
    return { fallback: `the mirror did not answer (${settled.map((lane) => (lane.ok ? "" : lane.error)).join("; ")})` };
  }
  const statusLines = settled.map((lane) => {
    if (!lane.ok) return `✗ ${lane.lane.toUpperCase()}: ${lane.error} — retry with ${lane.lane}_search`;
    const per = variants.length > 1 ? ` (per variant: ${lane.perVariant.map((n) => (n === null ? "✗" : String(n))).join(" · ")})` : "";
    const scope = lane.lane === "nss" ? (args.include_regional === true ? " — NSS + krajské soudy" : " — NSS only") : "";
    return `✓ ${lane.lane.toUpperCase()}: ${lane.hits.length} shown${per}${scope}${lane.failures.length ? ` ⚠ ${lane.failures.join("; ")}` : ""}`;
  });
  const items: MirrorHit[] = [];
  for (let rank = 0; rank < limit; rank++) {
    for (const lane of settled) if (lane.ok && lane.hits[rank]) items.push(lane.hits[rank]);
  }
  return text([
    MIRROR_NOTE,
    `Variants searched in parallel: ${variants.map((v) => `"${v}"`).join(", ")}`,
    ...statusLines,
    ...(wantsEu ? ["– SDEU: not in the mirror — search it with sdeu_search."] : []),
    "",
    ...(items.length ? items.map((hit, i) => hitLine(hit, i, true)) : ["No hits in the mirror — broaden the query or add variants."]),
    ...previewLines(items, readTop, true),
  ]);
}

// ── per-court search tools ──────────────────────────────────────────────────

interface CourtSearchSpec {
  court: MirrorCourt;
  /** Parameters the mirror honours (everything else must be unset). */
  handled: readonly string[];
  defaults: Record<string, unknown>;
  /** Whether the call asks for a page past the first. */
  laterPage: (args: Args) => boolean;
  /** Extra mirror parameters from the call; a string = fall back with that reason. */
  extra?: (args: Args) => Partial<MirrorSearchParams> | string;
  limit: (args: Args) => number;
}

const COMMON = ["query", "queries", "case_number", "date_from", "date_to", "read_top", "limit"];

const NS_CATEGORIES = /^[A-E]$/;
const US_TYPES: Record<string, string> = { nález: "nalez", usnesení: "usneseni", stanovisko: "stanovisko" };

const COURT_SEARCH: Record<string, CourtSearchSpec> = {
  ns_search: {
    court: "ns",
    handled: [...COMMON, "offset", "category"],
    defaults: {},
    laterPage: (args) => num(args.offset, 0) > 0,
    extra: (args) => {
      const category = str(args.category)?.toUpperCase();
      if (category && !NS_CATEGORIES.test(category)) return "unknown NS category";
      return category ? { categories: [category] } : {};
    },
    limit: (args) => num(args.limit, 20),
  },
  nss_search: {
    court: "nss",
    handled: [...COMMON, "page", "court"],
    defaults: {},
    laterPage: (args) => num(args.page, 1) > 1,
    extra: (args) => {
      const court = args.court;
      // rozšířený senát, krajské and kárné soudy are lanes of their own live;
      // the mirror only knows NSS alone or NSS + the regional courts.
      if (court === undefined || court === "nss") return {};
      return `the mirror has no "court: ${String(court)}" filter`;
    },
    limit: () => 20,
  },
  us_search: {
    court: "us",
    handled: [...COMMON, "page", "sort", "types", "ecli"],
    defaults: {},
    laterPage: (args) => num(args.page, 0) > 0,
    extra: (args) => {
      const types = Array.isArray(args.types) ? (args.types as string[]) : [];
      if (types.length > 1) return "the mirror filters one decision type at a time";
      const type = types[0] ? US_TYPES[types[0]] : undefined;
      if (types[0] && !type) return `unknown type ${types[0]}`;
      const ecli = str(args.ecli);
      return {
        sort: args.sort === "relevance" ? ("relevance" as const) : ("newest" as const),
        ...(type ? { type } : {}),
        // An ECLI is an identifier the mirror indexes like a sp. zn.
        ...(ecli ? { caseNumber: ecli } : {}),
      };
    },
    limit: () => 20,
  },
  justice_search: {
    court: "justice",
    handled: [...COMMON, "page", "sort"],
    defaults: { match: "all_words" },
    laterPage: (args) => num(args.page, 0) > 0,
    extra: (args) =>
      // Without words the live tool lists the newest; the mirror sorts by decision date.
      ({ sort: str(args.query) ? ("relevance" as const) : ("newest" as const) }),
    limit: (args) => num(args.limit, 20),
  },
};

async function courtSearch(name: string, args: Args): Promise<MirrorAnswer> {
  const spec = COURT_SEARCH[name];
  const refused = unsupported(args, spec.handled, spec.defaults);
  if (refused) return { fallback: refused };
  if (spec.laterPage(args)) return { fallback: "the mirror answers the first page only" };
  const variants = uniqueQueries(str(args.query), args.queries as string[] | undefined);
  const caseNumber = str(args.case_number);
  const extra = spec.extra?.(args) ?? {};
  if (typeof extra === "string") return { fallback: extra };
  if (!variants.length && !caseNumber && !extra.caseNumber) return { fallback: "no query or spisová značka" };
  const from = str(args.date_from);
  const to = str(args.date_to);
  if (dateRangeError(from, to)) return { fallback: "inverted date range" };
  const limit = Math.min(50, Math.max(1, spec.limit(args)));
  let run;
  try {
    run = await searchVariants(variants, {
      sources: [spec.court],
      ...(caseNumber ? { caseNumber } : {}),
      from,
      to,
      limit,
      ...extra,
    });
  } catch (error) {
    return { fallback: `the mirror did not answer (${error instanceof Error ? error.message : String(error)})` };
  }
  const hits = run.hits.slice(0, limit);
  const readTop = Math.min(3, Math.max(0, num(args.read_top, 0)));
  return text([
    MIRROR_NOTE,
    `${spec.court.toUpperCase()} in the mirror: ${hits.length} hit${hits.length === 1 ? "" : "s"} shown${
      variants.length > 1 ? ` (per variant: ${run.perVariant.map((n) => (n === null ? "✗" : String(n))).join(" · ")})` : ""
    }${run.failures.length ? ` ⚠ ${run.failures.join("; ")}` : ""}. The mirror returns the best ${limit} — narrow the query rather than paging.`,
    "",
    ...(hits.length ? hits.map((hit, i) => hitLine(hit, i, false)) : ["No hits in the mirror — broaden the query or add variants."]),
    ...previewLines(hits, readTop, false),
  ]);
}

// ── *_get_decision ──────────────────────────────────────────────────────────

const GET_TOOLS: Record<string, { court: MirrorCourt; idParam: string }> = {
  ns_get_decision: { court: "ns", idParam: "unid" },
  nss_get_decision: { court: "nss", idParam: "document_id" },
  us_get_decision: { court: "us", idParam: "sz" },
  justice_get_decision: { court: "justice", idParam: "uuid" },
};

async function getDecision(name: string, args: Args): Promise<MirrorAnswer> {
  const { court, idParam } = GET_TOOLS[name];
  const id = str(args[idParam]);
  if (!id) return { fallback: `no ${idParam}` };
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
  const paged = pageOrExcerpt(decision.text, Math.max(1, num(args.page, 1)), find);
  const meta = [
    decision.caseNumbers.length ? `Spisová značka: ${decision.caseNumbers.join("; ")}` : decision.caseNumber ? `Spisová značka: ${decision.caseNumber}` : null,
    decision.court ? `Soud: ${decision.court}` : null,
    decision.date ? `Datum rozhodnutí: ${decision.date}` : null,
    decision.form ? `Druh: ${FORM[decision.form] ?? decision.form}` : null,
    decision.category ? `Kategorie: ${decision.category}` : null,
    decision.ecli ? `ECLI: ${decision.ecli}` : null,
    decision.published ? `Zveřejněno: ${decision.published}` : null,
    decision.legalSentence ? `Právní věta: ${decision.legalSentence}` : null,
    decision.goneAt ? `⚠ The court no longer publishes this decision (since ${decision.goneAt.slice(0, 10)}).` : null,
    decision.url,
  ].filter(Boolean);
  return text([MIRROR_NOTE, ...(meta as string[]), "", `${paged.text}${continuationHint(paged)}`]);
}

// ── the routing table ───────────────────────────────────────────────────────

export const MIRROR_TOOLS: Record<string, (args: Args) => Promise<MirrorAnswer>> = {
  caselaw_search: caselawSearch,
  ...Object.fromEntries(Object.keys(COURT_SEARCH).map((name) => [name, (args: Args) => courtSearch(name, args)])),
  ...Object.fromEntries(Object.keys(GET_TOOLS).map((name) => [name, (args: Args) => getDecision(name, args)])),
};
