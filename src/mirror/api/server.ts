import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { Queryable } from "../db/client";
import { mirrorStatus } from "../status";
import type { DecisionType } from "../types";
import { decisionPage, getDecision, getImage, getImages, isMirrorSource, searchDecisions, MAX_LIMIT } from "./queries";
import { renderDecisionHtml } from "./render";

/**
 * API v1 of the mirror (v1-plan: jen LAN, bearer token), run as
 * mirror-api.service on LXC `app`, listening on its LAN address only:
 *
 *   GET /v1/search?q=&source=&court=&type=&from=&to=&case=&limit=
 *   GET /v1/decisions/:source/:id[?page=N | ?format=html]
 *   GET /v1/decisions/:source/:id/images/:ord
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

  app.get("/v1/status", async (c) => c.json(await mirrorStatus(db)));

  app.notFound((c) => c.json({ error: "not found" }, 404));
  return app;
}
