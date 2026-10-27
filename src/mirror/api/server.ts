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
  MAX_LIMIT,
} from "./queries";
import { renderDecisionHtml } from "./render";
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
 *   GET /v1/search?q=&source=&court=&type=&category=&from=&to=&case=&limit=   (category: NS A–E, "A,B"; source: "ns,nss")
 *   GET /v1/decisions/:source/:id[?page=N | ?format=html]
 *   GET /v1/decisions/:source/:id/images/:ord
 *   GET /v1/decisions/:source/:id/provisions        the § / články it cites
 *   GET /v1/provisions?cite= | act=&provision= [&source=&category=&from=&to=&limit=&offset=]
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

/** One court or several ("ns,nss", or source repeated); none = all. */
function sources(values: string[] | undefined): MirrorSource[] | undefined {
  const list = (values ?? [])
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter(Boolean);
  if (!list.every(isMirrorSource))
    throw new BadRequest(
      "source must be us, ns, nss, justice or sdeu, several as ns,nss",
    );
  return list.length ? [...new Set(list)] : undefined;
}

/** The BM25 index over decision_text is built and valid (CREATE INDEX CONCURRENTLY leaves it invalid until done). */
async function bm25Ready(db: Queryable): Promise<boolean> {
  const { rows } = await db.query<{ ok: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class x ON x.oid = i.indexrelid JOIN pg_namespace n ON n.oid = x.relnamespace
                    WHERE n.nspname = 'mirror' AND x.relname = 'decision_text_bm25' AND i.indisvalid) AS ok`,
  );
  return Boolean(rows[0]?.ok);
}

/** The courts whose chunks carry the RUM index (built per partition: decision_chunk_<source>_tsv_rum). */
async function rumSources(db: Queryable): Promise<Set<string>> {
  const { rows } = await db.query<{ source: string }>(
    `SELECT substr(t.relname, length('decision_chunk_') + 1) AS source
     FROM pg_index i JOIN pg_class x ON x.oid = i.indexrelid JOIN pg_am am ON am.oid = x.relam JOIN pg_class t ON t.oid = i.indrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE am.amname = 'rum' AND n.nspname = 'mirror' AND t.relname LIKE 'decision\\_chunk\\_%'`,
  );
  return new Set(rows.map((r) => r.source));
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
/**
 * The search alone gets 12 s (Glass waits 15) and 64 MB to sort in: RUM sorts every chunk a prefix
 * query matches, and the commonest phrases over all courts ("náhrada škody") take 3–4 s warm.
 */
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
    if (error instanceof BadRequest)
      return c.json({ error: error.message }, 400);
    // 57014: statement_timeout (5 s, the search 12 s) — the query, not the server, failed.
    if ((error as { code?: string }).code === "57014")
      return c.json({ error: "query timed out" }, 504);
    console.error(
      `mirror-api: ${error instanceof Error ? error.stack : String(error)}`,
    );
    return c.json({ error: "internal error" }, 500);
  });

  // Which courts the search may cut to the RUM index's first candidates (rechecked hourly: indexes are built by hand).
  const rum = stale(() => rumSources(db), 3_600_000, "rum indexes");
  const bm25 = stale(() => bm25Ready(db), 3_600_000, "bm25 index");
  rum.peek();
  bm25.peek();
  app.get("/v1/search", async (c) => {
    const q = c.req.query();
    const courts = sources(c.req.queries("source"));
    if (q.type && !TYPES.has(q.type as DecisionType))
      throw new BadRequest(
        "type must be rozsudek, usneseni, nalez, stanovisko or jine",
      );
    const limit = q.limit ? Number(q.limit) : undefined;
    if (
      limit !== undefined &&
      !(Number.isInteger(limit) && limit >= 1 && limit <= MAX_LIMIT)
    ) {
      throw new BadRequest(`limit must be 1–${MAX_LIMIT}`);
    }
    if (!q.q?.trim() && !q.case?.trim())
      throw new BadRequest("q or case is required");
    const started = performance.now();
    const result = await slow(
      db,
      (conn) =>
        searchDecisions(conn, {
          q: q.q?.slice(0, 1000),
          sources: courts,
          court: q.court || undefined,
          type: (q.type || undefined) as DecisionType | undefined,
          from: date(q.from, "from"),
          to: date(q.to, "to"),
          caseNumber: q.case || undefined,
          categories: categories(q.category),
          limit,
          rum: (courts ?? MIRROR_SOURCES).every((s) => rum.peek()?.data.has(s)),
      bm25: bm25.peek()?.data === true,
        }),
      SEARCH_TIMEOUT_MS,
      SEARCH_WORK_MEM,
    );
    return c.json({
      ...result,
      tookMs: Math.round(performance.now() - started),
    });
  });

  app.get("/v1/decisions/:source/:id", async (c) => {
    const { source, id } = c.req.param();
    if (!isMirrorSource(source))
      throw new BadRequest("source must be us, ns, nss, justice or sdeu");
    const decision = await getDecision(db, source, id);
    if (!decision) return c.json({ error: "not found" }, 404);
    if (c.req.query("format") === "html") {
      return c.html(
        renderDecisionHtml(decision, await getImages(db, source, id)),
      );
    }
    const page = Number(c.req.query("page") ?? "1");
    if (!(Number.isInteger(page) && page >= 1))
      throw new BadRequest("page must be a positive integer");
    return c.json(decisionPage(decision, page));
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

  app.get("/v1/decisions/:source/:id/provisions", async (c) => {
    const { source, id } = c.req.param();
    if (!isMirrorSource(source))
      throw new BadRequest("source must be us, ns, nss, justice or sdeu");
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
    const started = performance.now();
    const result = await decisionsByProvision(db, {
      act,
      provision,
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
