import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import type { Db } from "@/src/mirror/db/client";
import { saveDecision } from "@/src/mirror/db/store";
import { createMirrorApi } from "@/src/mirror/api/server";
import type { DecisionRecord } from "@/src/mirror/types";

/** The HTTP API (Hono, app.request) over the real schema in PGlite. */

interface Migrator {
  migrate(
    client: { query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> },
    options?: { dir?: string; rlsCheck?: boolean; log?: (line: string) => void },
  ): Promise<unknown>;
}

const TOKEN = "t".repeat(40);
const auth = { authorization: `Bearer ${TOKEN}` };
let pg: PGlite;
let app: Hono;

const png = Uint8Array.from(Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"));

function record(o: Partial<DecisionRecord>): DecisionRecord {
  return {
    source: "us",
    sourceId: "x",
    url: "https://nalus.usoud.cz/Search/GetText.aspx?sz=x",
    court: "Ústavní soud – I. senát",
    caseNumber: null,
    caseNumbers: [],
    decisionType: "usneseni",
    decidedOn: "2025-01-01",
    legalSentence: null,
    ecli: null,
    publishedOn: null,
    parserVersion: 2,
    text: null,
    ...o,
  };
}

const nalezBody =
  "Ústavní soud rozhodl o ústavní stížnosti.\n\n" +
  "Obecné soudy porušily právo stěžovatele na spravedlivý proces, když nepřihlédly k námitce promlčení. ".repeat(20) +
  "\nV Brně dne 18. června 2025\npředseda senátu\n\nOdlišné stanovisko\n\nNesouhlasím s většinou, promlčení nenastalo.";

beforeAll(async () => {
  pg = await PGlite.create();
  const m = (await import(/* @vite-ignore */ path.resolve(__dirname, "..", "scripts", "db-migrate.mjs"))) as Migrator;
  await m.migrate(
    {
      async query(text, params) {
        if (params) return (await pg.query(text, params)) as { rows: Record<string, unknown>[] };
        const results = await pg.exec(text);
        return { rows: (results.at(-1)?.rows ?? []) as Record<string, unknown>[] };
      },
    },
    { dir: path.resolve(__dirname, "..", "src", "mirror", "db", "migrations"), rlsCheck: false, log: () => undefined },
  );
  const db: Db = {
    query: (text, params) => pg.query(text, params) as never,
    transaction: (fn) => pg.transaction((tx) => fn({ query: (text, params) => tx.query(text, params) as never })),
  };
  await saveDecision(
    db,
    record({
      sourceId: "4-296-24_1",
      caseNumber: "IV. ÚS 296/24",
      caseNumbers: ["IV. ÚS 296/24"],
      court: "Ústavní soud – IV. senát",
      decisionType: "nalez",
      decidedOn: "2025-06-18",
      ecli: "ECLI:CZ:US:2025:4.US.296.24.1",
      legalSentence: "Promlčení <b>nelze</b> přehlédnout.",
      text: { body: nalezBody, source: "us:gettext-hidden" },
      images: [{ charAt: nalezBody.indexOf("\n\nOdlišné"), mime: "image/png", width: 609, height: 1, bytes: png }],
    }),
  );
  await saveDecision(
    db,
    record({
      sourceId: "1-10-25_1",
      caseNumber: "I. ÚS 10/25",
      caseNumbers: ["I. ÚS 10/25"],
      decidedOn: "2025-03-01",
      text: { body: "Ústavní stížnost se odmítá. Stěžovatel odkazuje na nález sp. zn. IV. ÚS 296/24 o promlčení.", source: "us:gettext-hidden" },
    }),
  );
  app = createMirrorApi({ db, token: TOKEN });
});
afterAll(async () => {
  await pg.close();
});

const get = (url: string, headers: Record<string, string> = auth) => app.request(url, { headers });

describe("auth", () => {
  it("refuses a missing or wrong token", async () => {
    expect((await get("/v1/status", {})).status).toBe(401);
    expect((await get("/v1/status", { authorization: "Bearer nope" })).status).toBe(401);
    expect((await get("/v1/status")).status).toBe(200);
  });

  it("refuses to start with a short token", () => {
    expect(() => createMirrorApi({ db: { query: async () => ({ rows: [] }) }, token: "short" })).toThrow(/32/);
  });
});

describe("GET /v1/search", () => {
  it("finds by words (any inflection), ranks, and marks the matches in the excerpt", async () => {
    const res = await get("/v1/search?q=" + encodeURIComponent("spravedlivého procesu promlčení"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.channel).toBe("and");
    expect(body.hits.map((h: { id: string }) => h.id)).toEqual(["4-296-24_1"]);
    const hit = body.hits[0];
    expect(hit).toMatchObject({ source: "us", caseNumber: "IV. ÚS 296/24", form: "nalez", date: "2025-06-18", inDissent: false });
    const marked = hit.highlights.map(([s, e]: [number, number]) => hit.excerpt.slice(s, e).toLowerCase());
    expect(marked).toEqual(expect.arrayContaining(["spravedlivý", "proces", "promlčení"]));
  });

  it("falls back to OR when AND finds nothing", async () => {
    const body = await (await get("/v1/search?q=" + encodeURIComponent("odmítá kosmonaut"))).json();
    expect(body.channel).toBe("or");
    expect(body.hits.map((h: { id: string }) => h.id)).toEqual(["1-10-25_1"]);
  });

  it("finds by case number: the decision itself and the decision citing it", async () => {
    const body = await (await get("/v1/search?q=" + encodeURIComponent("IV. ÚS 296/24"))).json();
    expect(body.identKeys).toContain("sz:4us296-2024");
    expect(body.hits.map((h: { id: string }) => h.id).sort()).toEqual(["1-10-25_1", "4-296-24_1"]);
  });

  it("filters by type, date and case", async () => {
    const q = encodeURIComponent("promlčení");
    const ids = async (extra: string) =>
      ((await (await get(`/v1/search?q=${q}${extra}`)).json()).hits as Array<{ id: string }>).map((h) => h.id).sort();
    expect(await ids("")).toEqual(["1-10-25_1", "4-296-24_1"]);
    expect(await ids("&type=nalez")).toEqual(["4-296-24_1"]);
    expect(await ids("&to=2025-04-01")).toEqual(["1-10-25_1"]);
    expect(await ids("&source=ns")).toEqual([]);
    expect(await ids(`&case=${encodeURIComponent("I. ÚS 10/25")}`)).toEqual(["1-10-25_1"]);
  });

  it("says when the excerpt lies in a dissent", async () => {
    const body = await (await get("/v1/search?q=" + encodeURIComponent("nesouhlasím s většinou"))).json();
    expect(body.hits[0]).toMatchObject({ id: "4-296-24_1", inDissent: true });
  });

  it("rejects bad parameters", async () => {
    expect((await get("/v1/search")).status).toBe(400);
    expect((await get("/v1/search?q=x&source=eu")).status).toBe(400);
    expect((await get("/v1/search?q=x&from=2025-13-40")).status).toBe(400);
    expect((await get("/v1/search?q=x&limit=500")).status).toBe(400);
  });
});

describe("GET /v1/decisions", () => {
  it("returns metadata, one text page and the pictures", async () => {
    const body = await (await get("/v1/decisions/us/4-296-24_1")).json();
    expect(body).toMatchObject({
      id: "4-296-24_1",
      form: "nalez",
      dissentAt: nalezBody.indexOf("Odlišné stanovisko"),
      images: [{ ord: 0, mime: "image/png", width: 609, height: 1, bytes: png.length }],
    });
    expect(body.text).toMatchObject({ page: 1, total_pages: 1, total_chars: nalezBody.length });
    expect(body.text.text).toBe(nalezBody);
  });

  it("renders the whole decision as HTML: picture inline, rule before the dissent, text escaped", async () => {
    const res = await get("/v1/decisions/us/4-296-24_1?format=html");
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toContain(`src="data:image/png;base64,${Buffer.from(png).toString("base64")}"`);
    expect(html.indexOf("<img")).toBeLessThan(html.indexOf('<hr class="dissent">'));
    expect(html.indexOf('<hr class="dissent">')).toBeLessThan(html.indexOf("Odlišné stanovisko"));
    expect(html).toContain("Promlčení &lt;b&gt;nelze&lt;/b&gt;");
  });

  it("serves a picture's bytes", async () => {
    const res = await get("/v1/decisions/us/4-296-24_1/images/0");
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(png))).toBe(true);
    expect((await get("/v1/decisions/us/4-296-24_1/images/1")).status).toBe(404);
  });

  it("404 for an unknown decision, 400 for an unknown source", async () => {
    expect((await get("/v1/decisions/us/9-9-99")).status).toBe(404);
    expect((await get("/v1/decisions/eu/x")).status).toBe(400);
  });
});

describe("GET /v1/status", () => {
  it("returns the per-source state", async () => {
    const body = await (await get("/v1/status")).json();
    expect(body.sources.find((s: { source: string }) => s.source === "us")).toMatchObject({
      decisions: 2,
      withText: 2,
      withDissent: 1,
      images: 1,
      types: { nalez: 1, usneseni: 1 },
    });
  });
});
