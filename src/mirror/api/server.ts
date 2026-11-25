import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { Queryable } from "../db/client";
import { mirrorStatus } from "../status";
import { MIRROR_SOURCES, type DecisionType, type MirrorSource } from "../types";
import {
  decisionPage,
  getDecision,
  getImage,
  getImages,
  isMirrorSource,
  searchDecisions,
  UnsupportedSearch,
  type SearchInput,
  MAX_LIMIT,
  MAX_OFFSET,
} from "./queries";
import { REGISTRY_RE, hasMeta, type CourtClass, type MetaFilters } from "./filters";
import { renderDecisionHtml } from "./render";
import { CITED_BY_MAX_LIMIT, citedBySummary, decisionsByCaseNumber, factsOfDecisions, linksOfDecision } from "./citations";
import { originalOf } from "./original";
import {
  ACT_GROUPS,
  ACTS_MAX_LIMIT,
  actCitations,
  suggestActs,
  type ActGroup,
} from "./acts";
import { loadActLookup } from "../legal/lookup";
import type { ActLookup } from "../legal/provisions";
import {
  decisionsByProvision,
  normalizeAct,
  normalizeProvision,
  parseCitation,
  provisionsOfDecision,
} from "./provisions";

/**
 * API v1 of the mirror (v1-plan: jen LAN, bearer token), run as
 * mirror-api.service on LXC `app`, listening on its LAN address only:
 *
 *   GET /v1/by-case?case=&source=   the decisions carrying that sp. zn. / ECLI as their own
 *   GET /v1/search?q=&source=&court=&type=&category=&from=&to=&case=&limit=   (category: NS A–E, "A,B"; source: "ns,nss")
 *       &offset=  &match=all|any|phrase  &newest_by=decided|published  &type=nalez,stanovisko
 *       filters outside the index (./filters.ts): &court_class= &registry= &area= &published_from= &published_to=
 *       &own_case=  &collection=1 (ÚS: in a Sbírka)  &act=&provision= | &cite=
 *       — without q or case, the filters list the decisions (with `total`)
 *                  &sort=relevance|newest &regional=1 (NSS with the regional courts) &per_source=N (one lane per court)
 *                  &in=vyrok (the words in výroky only)
 *                  &court_code=KSBR,KSBRJI (rozhodnuti.justice.cz court codes, any of them; with source=justice only)
 *   GET /v1/decisions/:source/:id[?page=N | ?format=html | ?format=original]   original: with the court's formatting (decision_raw)
 *   GET /v1/decisions/:source/:id/images/:ord
 *   GET /v1/decisions/:source/:id/provisions        the § / články it cites
 *   GET /v1/decisions/:source/:id/citations[?limit=&offset=&source=]   the decisions it cites, and those citing it
 *   GET /v1/provisions?cite= | act=&provision= [&source=&category=&from=&to=&sort=newest|cited&limit=&offset=]
 *                                                   decisions citing a provision
 *   GET /v1/acts?q=&group=cz|eu|intl&limit=          the act registry, for a picker
 *   GET /v1/status                                  cached: answers with the last count (asOf), recounts after 5 min
 *
 * Every route needs `Authorization: Bearer <MIRROR_API_TOKEN>`. Queries run
 * as mirror_reader with a 5 s statement timeout (the pool's).
 */

const TYPES = new Set<DecisionType>([
  "rozsudek",
  "usneseni",
  "nalez",
  "stanovisko",
  "jine",
]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function tokenMatches(header: string | undefined, token: string): boolean {
  const given = /^Bearer\s+(.+)$/i.exec(header ?? "")?.[1]?.trim();
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

class BadRequest extends Error {}

function categories(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const list = value
    .toUpperCase()
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  if (!list.every((c) => /^[A-E]$/.test(c)))
    throw new BadRequest("category must be A–E, several as A,B");
  return list;
}

/** Court codes of rozhodnuti.justice.cz ("KSBR,KSBRJI", or repeated), compared with the ECLI's court part. */
function courtCodes(values: string[] | undefined, courts: MirrorSource[] | undefined): string[] | undefined {
  const list = (values ?? [])
    .flatMap((v) => v.split(","))
    .map((v) => v.trim().toUpperCase())
    .filter(Boolean);
  if (!list.length) return undefined;
  if (!list.every((c) => /^[A-Z][A-Z0-9]{1,9}$/.test(c)) || list.length > 150)
    throw new BadRequest("court_code must be court codes such as KSBR, several as KSBR,KSBRJI");
  if (courts?.length !== 1 || courts[0] !== "justice")
    throw new BadRequest("court_code needs source=justice");
  return [...new Set(list)];
}

/** One court or several ("ns,nss", or source repeated); none = all. */
function sources(values: string[] | undefined): MirrorSource[] | undefined {
  const list = (values ?? [])
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter(Boolean);
  if (!list.every(isMirrorSource))
    throw new BadRequest(
      "source must be us, ns, nss or justice, several as ns,nss",
    );
  return list.length ? [...new Set(list)] : undefined;
}

/** The BM25 index over decision_text is built and valid (CREATE INDEX CONCURRENTLY leaves it invalid until done). */
async function bm25Ready(db: Queryable, index = "decision_text_bm25"): Promise<boolean> {
  const { rows } = await db.query<{ ok: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class x ON x.oid = i.indexrelid JOIN pg_namespace n ON n.oid = x.relnamespace
                    WHERE n.nspname = 'mirror' AND x.relname = $1 AND i.indisvalid) AS ok`,
    [index],
  );
  return Boolean(rows[0]?.ok);
}

function date(value: string | undefined, name: string): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (!ISO_DATE.test(value) || Number.isNaN(Date.parse(value)))
    throw new BadRequest(`${name} must be YYYY-MM-DD`);
  return value;
}

/** Status counts are served for 5 min, act citation counts for a day; either may take minutes to recount, not the API's 5 s. */
const STATUS_TTL_MS = 5 * 60_000;
const CITATIONS_TTL_MS = 24 * 3_600_000;
const SLOW_TIMEOUT_MS = 5 * 60_000;
/** The search alone gets 12 s (Glass waits 15) and 64 MB to sort in: without BM25 (index missing) it ranks chunks. */
const SEARCH_TIMEOUT_MS = 12_000;
const SEARCH_WORK_MEM = "64MB";

/** Run `fn` on one pooled connection with its own statement timeout (and work_mem); anything but pg's Pool runs it as is. */
async function slow<T>(
  db: Queryable,
  fn: (db: Queryable) => Promise<T>,
  timeoutMs = SLOW_TIMEOUT_MS,
  workMem?: string,
): Promise<T> {
  const pool = db as Queryable & {
    connect?: () => Promise<Queryable & { release(): void }>;
  };
  if (typeof pool.connect !== "function") return fn(db);
  const client = await pool.connect();
  try {
    await client.query(`SET statement_timeout = ${timeoutMs}`);
    if (workMem) await client.query(`SET work_mem = '${workMem}'`);
    return await fn(client);
  } finally {
    await client.query("RESET statement_timeout").catch(() => undefined);
    if (workMem) await client.query("RESET work_mem").catch(() => undefined);
    client.release();
  }
}

/** The last value of `load`, recomputed in the background once older than `ttl`; `get` waits only for the very first. */
function stale<T>(load: () => Promise<T>, ttl: number, name: string) {
  let value: { at: number; data: T } | null = null;
  let loading: Promise<T> | null = null;
  const refresh = () =>
    (loading ??= load()
      .then((data) => {
        value = { at: Date.now(), data };
        return data;
      })
      .finally(() => {
        loading = null;
      }));
  const peek = (): { at: number; data: T } | null => {
    if (!value || Date.now() - value.at > ttl)
      refresh().catch((error) =>
        console.error(`mirror-api: ${name}: ${error}`),
      );
    return value;
  };
  return {
    peek,
    get: async () => peek() ?? { at: Date.now(), data: await refresh() },
  };
}

export function createMirrorApi(options: {
  db: Queryable;
  token: string;
}): Hono {
  if (options.token.length < 32)
    throw new Error("MIRROR_API_TOKEN must be at least 32 characters");
  const { db } = options;
  const app = new Hono();

  app.use("*", async (c, next) => {
    if (!tokenMatches(c.req.header("authorization"), options.token)) {
      return c.json({ error: "unauthorized" }, 401, {
        "www-authenticate": "Bearer",
      });
    }
    await next();
  });

  app.onError((error, c) => {
    if (error instanceof BadRequest || error instanceof UnsupportedSearch)
      return c.json({ error: error.message }, 400);
    // 57014: statement_timeout (5 s, the search 12 s) — the query, not the server, failed.
    if ((error as { code?: string }).code === "57014")
      return c.json({ error: "query timed out" }, 504);
    console.error(
      `mirror-api: ${error instanceof Error ? error.stack : String(error)}`,
    );
    return c.json({ error: "internal error" }, 500);
  });

  // Whether the BM25 index is there and valid (rechecked hourly: it is built by hand, CONCURRENTLY).
  const bm25 = stale(() => bm25Ready(db), 3_600_000, "bm25 index");
  bm25.peek();
  const verdictBm25 = stale(() => bm25Ready(db, "decision_verdict_bm25"), 3_600_000, "verdict bm25 index");
  verdictBm25.peek();
  // The registry's names for `cite` on a search, loaded on the first one that needs them.
  let searchLookup: Promise<ActLookup> | null = null;
  app.get("/v1/search", async (c) => {
    const q = c.req.query();
    const courts = sources(c.req.queries("source"));
    // One form or several ("nalez,stanovisko").
    const types = (q.type ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean) as DecisionType[];
    if (!types.every((t) => TYPES.has(t)))
      throw new BadRequest(
        "type must be rozsudek, usneseni, nalez, stanovisko or jine (several: nalez,stanovisko)",
      );
    const offset = q.offset ? Number(q.offset) : undefined;
    if (offset !== undefined && !(Number.isInteger(offset) && offset >= 0 && offset <= MAX_OFFSET))
      throw new BadRequest(`offset must be 0–${MAX_OFFSET} — narrow the search rather than page deeper`);
    if (q.match && q.match !== "all" && q.match !== "any" && q.match !== "phrase")
      throw new BadRequest("match must be all, any or phrase");
    if (q.newest_by && q.newest_by !== "decided" && q.newest_by !== "published")
      throw new BadRequest("newest_by must be decided or published");
    // The filters outside the BM25 index (./filters.ts).
    const meta: MetaFilters = {};
    if (q.court_class) {
      if (!["nss", "rozsireny", "krajske", "karne"].includes(q.court_class))
        throw new BadRequest("court_class must be nss, rozsireny, krajske or karne");
      meta.courtClass = q.court_class as CourtClass;
    }
    if (q.registry) {
      if (!REGISTRY_RE.test(q.registry.trim())) throw new BadRequest("registry must be a docket registry such as Afs, Azs, Cdo");
      meta.registry = q.registry.trim();
    }
    if (q.area?.trim()) meta.area = q.area.trim().slice(0, 100);
    meta.publishedFrom = date(q.published_from, "published_from");
    meta.publishedTo = date(q.published_to, "published_to");
    if (q.own_case?.trim()) meta.ownCase = q.own_case.trim().slice(0, 120);
    if (q.collection === "1" || q.collection === "true") meta.inCollection = true;
    if (q.cite?.trim()) {
      searchLookup ??= loadActLookup(db).catch((error) => {
        searchLookup = null;
        throw error;
      });
      const parsed = parseCitation(q.cite.slice(0, 300), await searchLookup);
      if (!parsed) throw new BadRequest("cite: no § or článek found");
      if (!parsed.act) throw new BadRequest("cite: the act was not recognised — give its number (zákona č. 89/2012 Sb.) or use act=");
      meta.act = parsed.act;
      meta.provision = parsed.provision;
    }
    if (q.act) {
      const act = normalizeAct(q.act);
      if (!act) throw new BadRequest("act must be like 89/2012, zak:89/2012 or 32016R0679");
      meta.act = act;
    }
    if (q.provision) {
      const provision = normalizeProvision(q.provision);
      if (!provision) throw new BadRequest("provision must be like par:2913/o1 or § 2913 odst. 1");
      if (!meta.act) throw new BadRequest("provision needs act (or use cite)");
      meta.provision = provision;
    }
    const limit = q.limit ? Number(q.limit) : undefined;
    if (
      limit !== undefined &&
      !(Number.isInteger(limit) && limit >= 1 && limit <= MAX_LIMIT)
    ) {
      throw new BadRequest(`limit must be 1–${MAX_LIMIT}`);
    }
    // Words, a značka, or at least one filter: a call with none of them would list the whole mirror.
    const filtered =
      Boolean(courts?.length || types.length || q.from || q.to || q.category || q.court || c.req.queries("court_code")?.length) || hasMeta(meta);
    if (!q.q?.trim() && !q.case?.trim() && !filtered)
      throw new BadRequest("q, case or a filter (source, dates, type, court, registry, area, act …) is required");
    if (q.sort && q.sort !== "relevance" && q.sort !== "newest")
      throw new BadRequest("sort must be relevance or newest");
    if (q.in && q.in !== "vyrok") throw new BadRequest("in must be vyrok");
    const perSource = q.per_source ? Number(q.per_source) : undefined;
    if (
      perSource !== undefined &&
      !(Number.isInteger(perSource) && perSource >= 1 && perSource <= MAX_LIMIT)
    ) {
      throw new BadRequest(`per_source must be 1–${MAX_LIMIT}`);
    }
    const input: SearchInput = {
      q: q.q?.slice(0, 1000),
      sources: courts,
      court: q.court || undefined,
      courtCodes: courtCodes(c.req.queries("court_code"), courts),
      types: types.length ? types : undefined,
      meta: hasMeta(meta) ? meta : undefined,
      match: (q.match || undefined) as SearchInput["match"],
      offset,
      newestBy: (q.newest_by || undefined) as SearchInput["newestBy"],
      from: date(q.from, "from"),
      to: date(q.to, "to"),
      caseNumber: q.case || undefined,
      categories: categories(q.category),
      regional: q.regional === "1" || q.regional === "true",
      sort: (q.sort || undefined) as SearchInput["sort"],
      in: q.in ? "vyrok" : undefined,
      verdictBm25: verdictBm25.peek()?.data === true,
      limit,
      bm25: bm25.peek()?.data === true,
    };
    const run = (one: SearchInput) =>
      slow(db, (conn) => searchDecisions(conn, one), SEARCH_TIMEOUT_MS, SEARCH_WORK_MEM);
    // Length and citing count of the hits shown — one more query, and a failure leaves the hits as they are.
    const withFacts = async <T extends { source: MirrorSource; id: string }>(hits: T[]): Promise<T[]> => {
      try {
        const facts = await factsOfDecisions(db, hits);
        return hits.map((hit) => ({ ...hit, ...(facts.get(`${hit.source}:${hit.id}`) ?? {}) }));
      } catch (error) {
        console.error(`mirror-api: hit facts: ${error}`);
        return hits;
      }
    };
    const started = performance.now();
    if (perSource !== undefined) {
      // One lane per court, as caselaw_search: a court with many matches does not push the others out.
      const lanes = courts ?? MIRROR_SOURCES;
      const results = await Promise.all(
        lanes.map(async (s) => {
          const one = await run({ ...input, sources: [s], limit: perSource });
          return { ...one, hits: await withFacts(one.hits) };
        }),
      );
      return c.json({
        lanes: Object.fromEntries(lanes.map((s, i) => [s, { hits: results[i].hits, channel: results[i].channel }])),
        terms: results[0]?.terms ?? [],
        identKeys: results[0]?.identKeys ?? [],
        tookMs: Math.round(performance.now() - started),
      });
    }
    const result = await run(input);
    return c.json({
      ...result,
      hits: await withFacts(result.hits),
      tookMs: Math.round(performance.now() - started),
    });
  });

  app.get("/v1/decisions/:source/:id", async (c) => {
    const { source, id } = c.req.param();
    if (!isMirrorSource(source))
      throw new BadRequest("source must be us, ns, nss or justice");
    const decision = await getDecision(db, source, id);
    if (!decision) return c.json({ error: "not found" }, 404);
    const format = c.req.query("format");
    if (format === "html" || format === "original") {
      // original: the court's formatting from decision_raw where it can be read, the plain text otherwise.
      const images = await getImages(db, source, id);
      const formatted = format === "original" ? await originalOf(db, source, id, images) : null;
      return c.html(renderDecisionHtml(decision, images, formatted));
    }
    const page = Number(c.req.query("page") ?? "1");
    if (!(Number.isInteger(page) && page >= 1))
      throw new BadRequest("page must be a positive integer");
    // Page 1 says who cites the decision (a line of the reader's header); a failure costs the line, not the text.
    const citedBy = page === 1 ? await citedBySummary(db, source, id).catch(() => null) : null;
    return c.json({ ...decisionPage(decision, page), ...(citedBy ? { citedBy } : {}) });
  });

  app.get("/v1/decisions/:source/:id/images/:ord", async (c) => {
    const { source, id, ord } = c.req.param();
    if (!isMirrorSource(source) || !/^\d{1,4}$/.test(ord))
      throw new BadRequest("bad source or image number");
    const image = await getImage(db, source, id, Number(ord));
    if (!image) return c.json({ error: "not found" }, 404);
    return c.body(Buffer.from(image.bytes), 200, {
      "content-type": image.mime,
      etag: `"${image.sha256}"`,
      "cache-control": "private, max-age=86400",
    });
  });

  // The decisions carrying a sp. zn. / ECLI as their own (exact), for the citator's lookup by case number.
  app.get("/v1/by-case", async (c) => {
    const value = c.req.query("case")?.trim();
    if (!value || value.length > 120) throw new BadRequest("case is required (a spisová značka or ECLI, at most 120 characters)");
    return c.json({ decisions: await decisionsByCaseNumber(db, value, sources(c.req.queries("source"))) });
  });

  app.get("/v1/decisions/:source/:id/citations", async (c) => {
    const { source, id } = c.req.param();
    if (!isMirrorSource(source))
      throw new BadRequest("source must be us, ns, nss or justice");
    const q = c.req.query();
    const limit = q.limit ? Number(q.limit) : undefined;
    if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1 && limit <= CITED_BY_MAX_LIMIT))
      throw new BadRequest(`limit must be 1–${CITED_BY_MAX_LIMIT}`);
    const offset = q.offset ? Number(q.offset) : undefined;
    if (offset !== undefined && !(Number.isInteger(offset) && offset >= 0))
      throw new BadRequest("offset must be 0 or more");
    if (q.order && q.order !== "newest" && q.order !== "courts") throw new BadRequest("order must be newest or courts");
    const links = await linksOfDecision(db, source, id, {
      limit,
      offset,
      citedBySource: sources(c.req.queries("source")),
      order: (q.order || undefined) as "newest" | "courts" | undefined,
    });
    if (!links) return c.json({ error: "not found" }, 404);
    return c.json(links);
  });

  app.get("/v1/decisions/:source/:id/provisions", async (c) => {
    const { source, id } = c.req.param();
    if (!isMirrorSource(source))
      throw new BadRequest("source must be us, ns, nss or justice");
    const provisions = await provisionsOfDecision(db, source, id);
    if (!provisions) return c.json({ error: "not found" }, 404);
    return c.json({ provisions });
  });

  // The registry's names, loaded on the first citation that needs them.
  let lookup: Promise<ActLookup> | null = null;
  app.get("/v1/provisions", async (c) => {
    const q = c.req.query();
    let act: string | null = null;
    let provision: string | null = null;
    if (q.cite?.trim()) {
      lookup ??= loadActLookup(db).catch((error) => {
        lookup = null;
        throw error;
      });
      const parsed = parseCitation(q.cite.slice(0, 300), await lookup);
      if (!parsed) throw new BadRequest("cite: no § or článek found");
      if (!parsed.act)
        throw new BadRequest(
          "cite: the act was not recognised — give its number (zákona č. 89/2012 Sb.) or use act=",
        );
      ({ act, provision } = parsed);
    }
    if (q.act) {
      act = normalizeAct(q.act);
      if (!act)
        throw new BadRequest(
          "act must be like 89/2012, zak:89/2012 or 32016R0679",
        );
    }
    if (q.provision) {
      provision = normalizeProvision(q.provision);
      if (!provision)
        throw new BadRequest(
          "provision must be like par:2913/o1 or § 2913 odst. 1",
        );
    }
    if (!act || !provision)
      throw new BadRequest("cite, or act and provision, are required");
    const courts = sources(c.req.queries("source"));
    const limit = q.limit ? Number(q.limit) : 20;
    if (!(Number.isInteger(limit) && limit >= 1 && limit <= MAX_LIMIT))
      throw new BadRequest(`limit must be 1–${MAX_LIMIT}`);
    const offset = q.offset ? Number(q.offset) : 0;
    if (!(Number.isInteger(offset) && offset >= 0 && offset <= 10_000))
      throw new BadRequest("offset must be 0–10000");
    if (q.sort && q.sort !== "newest" && q.sort !== "cited") throw new BadRequest("sort must be newest or cited");
    const started = performance.now();
    const result = await decisionsByProvision(db, {
      act,
      provision,
      sort: (q.sort || undefined) as "newest" | "cited" | undefined,
      sources: courts,
      categories: categories(q.category),
      from: date(q.from, "from"),
      to: date(q.to, "to"),
      limit,
      offset,
    });
    return c.json({
      act,
      provision,
      ...result,
      tookMs: Math.round(performance.now() - started),
    });
  });

  // How many decisions cite each act (a minute over the whole mirror): the picker's order once known.
  const citations = stale(
    () => slow(db, actCitations),
    CITATIONS_TTL_MS,
    "act citations",
  );
  app.get("/v1/acts", async (c) => {
    const q = c.req.query();
    if (!q.q?.trim()) throw new BadRequest("q is required");
    if (q.group && !ACT_GROUPS.includes(q.group as ActGroup))
      throw new BadRequest("group must be cz, eu or intl");
    const limit = q.limit ? Number(q.limit) : undefined;
    if (
      limit !== undefined &&
      !(Number.isInteger(limit) && limit >= 1 && limit <= ACTS_MAX_LIMIT)
    ) {
      throw new BadRequest(`limit must be 1–${ACTS_MAX_LIMIT}`);
    }
    const cited = citations.peek()?.data;
    return c.json({
      acts: await suggestActs(db, {
        q: q.q,
        group: (q.group || undefined) as ActGroup | undefined,
        limit,
        cited,
      }),
    });
  });

  // The counts scan every decision (seconds on the full mirror): served from the last count.
  const status = stale(() => slow(db, mirrorStatus), STATUS_TTL_MS, "status");
  app.get("/v1/status", async (c) => {
    const { at, data } = await status.get();
    return c.json({ ...data, asOf: new Date(at).toISOString() });
  });

  app.notFound((c) => c.json({ error: "not found" }, 404));
  return app;
}
