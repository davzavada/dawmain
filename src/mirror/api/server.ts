import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { Queryable } from "../db/client";
import { mirrorStatus } from "../status";
import type { DecisionType } from "../types";
import { decisionPage, getDecision, getImage, getImages, isMirrorSource, searchDecisions, MAX_LIMIT } from "./queries";
import { renderDecisionHtml } from "./render";
import { loadActLookup } from "../legal/lookup";
import type { ActLookup } from "../legal/provisions";
import { decisionsByProvision, normalizeAct, normalizeProvision, parseCitation, provisionsOfDecision } from "./provisions";

/**
 * API v1 of the mirror (v1-plan: jen LAN, bearer token), run as
 * mirror-api.service on LXC `app`, listening on its LAN address only:
 *
 *   GET /v1/search?q=&source=&court=&type=&category=&from=&to=&case=&limit=   (category: NS A–E, "A,B")
 *   GET /v1/decisions/:source/:id[?page=N | ?format=html]
 *   GET /v1/decisions/:source/:id/images/:ord
 *   GET /v1/decisions/:source/:id/provisions        the § / články it cites
 *   GET /v1/provisions?cite= | act=&provision= [&source=&category=&from=&to=&limit=&offset=]
 *                                                   decisions citing a provision
 *   GET /v1/status
 *
 * Every route needs `Authorization: Bearer <MIRROR_API_TOKEN>`. Queries run
 * as mirror_reader with a 5 s statement timeout (the pool's).
 */

const TYPES = new Set<DecisionType>(["rozsudek", "usneseni", "nalez", "stanovisko", "jine"]);
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
  const list = value.toUpperCase().split(",").map((c) => c.trim()).filter(Boolean);
  if (!list.every((c) => /^[A-E]$/.test(c))) throw new BadRequest("category must be A–E, several as A,B");
  return list;
}

function date(value: string | undefined, name: string): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (!ISO_DATE.test(value) || Number.isNaN(Date.parse(value))) throw new BadRequest(`${name} must be YYYY-MM-DD`);
  return value;
}

export function createMirrorApi(options: { db: Queryable; token: string }): Hono {
  if (options.token.length < 32) throw new Error("MIRROR_API_TOKEN must be at least 32 characters");
  const { db } = options;
  const app = new Hono();

  app.use("*", async (c, next) => {
    if (!tokenMatches(c.req.header("authorization"), options.token)) {
      return c.json({ error: "unauthorized" }, 401, { "www-authenticate": "Bearer" });
    }
    await next();
  });

  app.onError((error, c) => {
    if (error instanceof BadRequest) return c.json({ error: error.message }, 400);
    // 57014: statement_timeout (5 s) — the query, not the server, failed.
    if ((error as { code?: string }).code === "57014") return c.json({ error: "query timed out (5 s)" }, 504);
    console.error(`mirror-api: ${error instanceof Error ? error.stack : String(error)}`);
    return c.json({ error: "internal error" }, 500);
  });

  app.get("/v1/search", async (c) => {
    const q = c.req.query();
    if (q.source && !isMirrorSource(q.source)) throw new BadRequest("source must be us, ns, nss, justice or sdeu");
    if (q.type && !TYPES.has(q.type as DecisionType)) throw new BadRequest("type must be rozsudek, usneseni, nalez, stanovisko or jine");
    const limit = q.limit ? Number(q.limit) : undefined;
    if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1 && limit <= MAX_LIMIT)) {
      throw new BadRequest(`limit must be 1–${MAX_LIMIT}`);
    }
    if (!q.q?.trim() && !q.case?.trim()) throw new BadRequest("q or case is required");
    const started = performance.now();
    const result = await searchDecisions(db, {
      q: q.q?.slice(0, 1000),
      source: q.source as never,
      court: q.court || undefined,
      type: (q.type || undefined) as DecisionType | undefined,
      from: date(q.from, "from"),
      to: date(q.to, "to"),
      caseNumber: q.case || undefined,
      categories: categories(q.category),
      limit,
    });
    return c.json({ ...result, tookMs: Math.round(performance.now() - started) });
  });

  app.get("/v1/decisions/:source/:id", async (c) => {
    const { source, id } = c.req.param();
    if (!isMirrorSource(source)) throw new BadRequest("source must be us, ns, nss, justice or sdeu");
    const decision = await getDecision(db, source, id);
    if (!decision) return c.json({ error: "not found" }, 404);
    if (c.req.query("format") === "html") {
      return c.html(renderDecisionHtml(decision, await getImages(db, source, id)));
    }
    const page = Number(c.req.query("page") ?? "1");
    if (!(Number.isInteger(page) && page >= 1)) throw new BadRequest("page must be a positive integer");
    return c.json(decisionPage(decision, page));
  });

  app.get("/v1/decisions/:source/:id/images/:ord", async (c) => {
    const { source, id, ord } = c.req.param();
    if (!isMirrorSource(source) || !/^\d{1,4}$/.test(ord)) throw new BadRequest("bad source or image number");
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
    if (!isMirrorSource(source)) throw new BadRequest("source must be us, ns, nss, justice or sdeu");
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
      if (!parsed.act) throw new BadRequest("cite: the act was not recognised — give its number (zákona č. 89/2012 Sb.) or use act=");
      ({ act, provision } = parsed);
    }
    if (q.act) {
      act = normalizeAct(q.act);
      if (!act) throw new BadRequest("act must be like 89/2012, zak:89/2012 or 32016R0679");
    }
    if (q.provision) {
      provision = normalizeProvision(q.provision);
      if (!provision) throw new BadRequest("provision must be like par:2913/o1 or § 2913 odst. 1");
    }
    if (!act || !provision) throw new BadRequest("cite, or act and provision, are required");
    if (q.source && !isMirrorSource(q.source)) throw new BadRequest("source must be us, ns, nss, justice or sdeu");
    const limit = q.limit ? Number(q.limit) : 20;
    if (!(Number.isInteger(limit) && limit >= 1 && limit <= MAX_LIMIT)) throw new BadRequest(`limit must be 1–${MAX_LIMIT}`);
    const offset = q.offset ? Number(q.offset) : 0;
    if (!(Number.isInteger(offset) && offset >= 0 && offset <= 10_000)) throw new BadRequest("offset must be 0–10000");
    const started = performance.now();
    const result = await decisionsByProvision(db, {
      act,
      provision,
      source: (q.source || undefined) as never,
      categories: categories(q.category),
      from: date(q.from, "from"),
      to: date(q.to, "to"),
      limit,
      offset,
    });
    return c.json({ act, provision, ...result, tookMs: Math.round(performance.now() - started) });
  });

  app.get("/v1/status", async (c) => c.json(await mirrorStatus(db)));

  app.notFound((c) => c.json({ error: "not found" }, 404));
  return app;
}
