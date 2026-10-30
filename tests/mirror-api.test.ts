import path from "node:path";
import { gzipSync } from "node:zlib";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import type { Db } from "@/src/mirror/db/client";
import { saveDecision } from "@/src/mirror/db/store";
import { createMirrorApi } from "@/src/mirror/api/server";
import { buildActLookup } from "@/src/mirror/legal/lookup";
import { provisionsSource } from "@/src/mirror/provisions";
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
const photo = Uint8Array.from(Buffer.from("ffd8ffe000104a46", "hex"));

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
      images: [
        { charAt: nalezBody.indexOf("\n\nOdlišné"), mime: "image/png", width: 609, height: 1, bytes: png },
        { charAt: nalezBody.indexOf("\nV Brně"), mime: "image/jpeg", width: 200, height: 100, bytes: photo },
      ],
    }),
  );
  await saveDecision(
    db,
    record({
      sourceId: "1-10-25_1",
      caseNumber: "I. ÚS 10/25",
      caseNumbers: ["I. ÚS 10/25"],
      decidedOn: "2025-03-01",
      text: { body: "Ústavní stížnost se odmítá. Stěžovatel odkazuje na nález sp. zn. IV. ÚS 296/24 o promlčení. Namítá porušení § 2913 odst. 1 písm. b) zákona č. 89/2012 Sb. a čl. 36 odst. 1 Listiny.", source: "us:gettext-hidden" },
    }),
  );
  await pg.query(`INSERT INTO mirror.act (id, collection, kind, number, year, title, origin) VALUES ('zak:89/2012', 'sb', 'zákon', '89', 2012, 'Zákon občanský zákoník', 'esbirka')`);
  const counts = { fetched: 0, changed: 0, failed: 0 };
  await provisionsSource({ db, log: () => undefined }, "us", buildActLookup([]), counts);
  expect(counts).toEqual({ fetched: 2, changed: 2, failed: 0 });
  // A second run finds nothing to do: provision_state holds text and version.
  await provisionsSource({ db, log: () => undefined }, "us", buildActLookup([]), counts);
  expect(counts.fetched).toBe(2);
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

  it("a phrase in quotes keeps word order; word* finds every word that starts so", async () => {
    const ids = async (q: string) =>
      ((await (await get(`/v1/search?q=${encodeURIComponent(q)}`)).json()).hits as Array<{ id: string }>).map((h) => h.id);
    expect(await ids('"spravedlivý proces"')).toEqual(["4-296-24_1"]);
    expect(await ids('"proces spravedlivý"')).toEqual([]);
    expect(await ids("spravedliv*")).toEqual(["4-296-24_1"]);
    const body = await (await get(`/v1/search?q=${encodeURIComponent("stěžovat*")}`)).json();
    expect(body.hits.length).toBe(2);
    expect(body.terms).toContain("stezovat");
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
    expect(await ids("&source=ns,us")).toEqual(["1-10-25_1", "4-296-24_1"]);
    expect(await ids("&source=ns&source=us")).toEqual(["1-10-25_1", "4-296-24_1"]);
    expect(await ids(`&case=${encodeURIComponent("I. ÚS 10/25")}`)).toEqual(["1-10-25_1"]);
  });

  it("says when the excerpt lies in a dissent", async () => {
    const body = await (await get("/v1/search?q=" + encodeURIComponent("nesouhlasím s většinou"))).json();
    expect(body.hits[0]).toMatchObject({ id: "4-296-24_1", inDissent: true, dissent: 0 });
  });

  it("rejects bad parameters", async () => {
    expect((await get("/v1/search")).status).toBe(400);
    expect((await get("/v1/search?q=x&source=eu")).status).toBe(400);
    expect((await get("/v1/search?q=x&source=ns,eu")).status).toBe(400);
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
      dissents: [{ ord: 0, charStart: nalezBody.indexOf("Odlišné stanovisko"), charEnd: nalezBody.length, heading: "Odlišné stanovisko" }],
      images: [
        { ord: 0, mime: "image/png", width: 609, height: 1, bytes: png.length },
        { ord: 1, mime: "image/jpeg", width: 200, height: 100, bytes: photo.length },
      ],
    });
    expect(body.text).toMatchObject({ page: 1, total_pages: 1, total_chars: nalezBody.length });
    expect(body.text.text).toBe(nalezBody);
  });

  it("renders the whole decision as HTML: NALUS's separator as the one rule before the dissent, text escaped", async () => {
    const res = await get("/v1/decisions/us/4-296-24_1?format=html");
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const html = await res.text();
    expect(html.match(/<hr class="dissent">/g)).toHaveLength(1);
    expect(html.indexOf('<hr class="dissent">')).toBeLessThan(html.indexOf("Odlišné stanovisko"));
    expect(html).toContain("Promlčení &lt;b&gt;nelze&lt;/b&gt;");
  });

  it("format=original: the court's formatting from decision_raw, the plain text without it", async () => {
    const plain = await (await get("/v1/decisions/us/4-296-24_1?format=original")).text();
    expect(plain).toContain('<main data-format="text">');
    const page = `<input id="docContentHidden" value="\\qc \\b NÁLEZ\\b0\\par\\pard Ústavní soud rozhodl takto: stížnosti se vyhovuje.\\par">`;
    await pg.query(
      `INSERT INTO mirror.decision_raw (decision_id, url, status, content_type, bytes, sha256, gz)
       SELECT id, url, 200, 'text/html; charset=utf-8', $1, 'x', $2 FROM mirror.decision WHERE source = 'us' AND source_id = '4-296-24_1'`,
      [page.length, gzipSync(Buffer.from(page))],
    );
    const html = await (await get("/v1/decisions/us/4-296-24_1?format=original")).text();
    expect(html).toContain('<main data-format="original">');
    expect(html).toContain('<p class="al-center"><strong>NÁLEZ</strong></p>');
    expect(html).toContain("Promlčení"); // the header and právní věta as with format=html
  });

  it("draws a real picture inline", async () => {
    const html = await (await get("/v1/decisions/us/4-296-24_1?format=html")).text();
    expect(html).toContain(`src="data:image/jpeg;base64,${Buffer.from(photo).toString("base64")}"`);
    expect(html.indexOf("<img")).toBeLessThan(html.indexOf('<hr class="dissent">'));
  });

  it("serves a picture's bytes", async () => {
    const res = await get("/v1/decisions/us/4-296-24_1/images/0");
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(png))).toBe(true);
    expect((await get("/v1/decisions/us/4-296-24_1/images/2")).status).toBe(404);
  });

  it("404 for an unknown decision, 400 for an unknown source", async () => {
    expect((await get("/v1/decisions/us/9-9-99")).status).toBe(404);
    expect((await get("/v1/decisions/eu/x")).status).toBe(400);
  });
});

describe("search by cited provision", () => {
  it("finds a decision by any level of the provision, from a key or a citation", async () => {
    for (const url of [
      "/v1/provisions?act=89/2012&provision=par:2913",
      "/v1/provisions?act=zak:89/2012&provision=§ 2913 odst. 1 písm. b)",
      `/v1/provisions?cite=${encodeURIComponent("§ 2913 odst. 1 zákona č. 89/2012 Sb.")}`,
    ]) {
      const body = await (await get(url)).json();
      expect(body.total, url).toBe(1);
      expect(body.hits[0]).toMatchObject({ id: "1-10-25_1", caseNumber: "I. ÚS 10/25", mentions: 1 });
      expect(body.hits[0].excerpt).toContain("§ 2913 odst. 1 písm. b)");
    }
    expect((await (await get("/v1/provisions?act=zak:2/1993&provision=cl:36/o1")).json()).total).toBe(1);
    expect((await (await get("/v1/provisions?act=89/2012&provision=par:2914")).json()).total).toBe(0);
    expect((await (await get("/v1/provisions?act=89/2012&provision=par:2913&source=ns,nss")).json()).total).toBe(0);
    expect((await (await get("/v1/provisions?act=89/2012&provision=par:2913&source=nss,us")).json()).total).toBe(1);
  });

  it("lists what a decision cites, deepest keys with the act's title", async () => {
    const body = await (await get("/v1/decisions/us/1-10-25_1/provisions")).json();
    expect(body.provisions).toEqual([
      expect.objectContaining({ act: "zak:89/2012", actTitle: "Zákon občanský zákoník", provision: "par:2913/o1/pb" }),
      expect.objectContaining({ act: "zak:2/1993", provision: "cl:36/o1" }),
    ]);
  });

  it("filters by NS category", async () => {
    // The ÚS decisions have none: any category filter leaves them out.
    expect((await (await get("/v1/provisions?act=89/2012&provision=par:2913&category=A,B")).json()).total).toBe(0);
    expect((await get("/v1/provisions?act=89/2012&provision=par:2913&category=Z")).status).toBe(400);
    expect((await (await get("/v1/search?q=promlčení&category=A")).json()).hits).toEqual([]);
  });

  it("explains a bad request", async () => {
    expect((await get("/v1/provisions?act=89/2012")).status).toBe(400);
    expect((await get("/v1/provisions?act=nonsense&provision=par:1")).status).toBe(400);
    expect((await get(`/v1/provisions?cite=${encodeURIComponent("§ 5 něčeho")}`)).status).toBe(400);
  });
});

describe("GET /v1/acts", () => {
  beforeAll(async () => {
    await pg.query(
      `INSERT INTO mirror.act (id, collection, kind, number, year, title, short_title, origin) VALUES
         ('zak:99/1963', 'sb', 'zákon', '99', 1963, 'Zákon občanský soudní řád', null, 'esbirka'),
         ('zak:40/1964', 'sb', 'zákon', '40', 1964, 'Zákon občanský zákoník', null, 'esbirka'),
         ('zak:209/1992', 'sb', 'sdělení', '209', 1992, 'Sdělení federálního ministerstva zahraničních věcí o sjednání Úmluvy o ochraně lidských práv a základních svobod', null, 'esbirka'),
         ('sm:12/2005', 'sm', 'sdělení', '12', 2005, 'Sdělení Ministerstva zahraničních věcí o sjednání Smlouvy o přistoupení', null, 'esbirka'),
         ('eu:32016R0679', 'eu', 'nařízení', '679', 2016, 'Nařízení Evropského parlamentu a Rady (EU) 2016/679 o ochraně fyzických osob v souvislosti se zpracováním osobních údajů', null, 'cellar')`,
    );
    await pg.query(
      `INSERT INTO mirror.act_alias (alias, act_id, kind, origin) VALUES
         ('OSŘ', 'zak:99/1963', 'abbreviation', 'table'), ('o. s. ř.', 'zak:99/1963', 'abbreviation', 'table'),
         ('GDPR', 'eu:32016R0679', 'abbreviation', 'table'), ('EÚLP', 'zak:209/1992', 'abbreviation', 'table')`,
    );
  });
  const ids = async (url: string) => ((await (await get(url)).json()).acts as Array<{ id: string }>).map((a) => a.id);

  it("finds by words, newest first, and by number", async () => {
    expect(await ids("/v1/acts?q=ob%C4%8Dansk%C3%BD%20z%C3%A1kon%C3%ADk")).toEqual(["zak:89/2012", "zak:40/1964"]);
    expect(await ids("/v1/acts?q=40/1964")).toEqual(["zak:40/1964"]);
    expect(await ids("/v1/acts?q=32016R0679")).toEqual(["eu:32016R0679"]);
  });

  it("puts an exact abbreviation first and returns it", async () => {
    const body = await (await get("/v1/acts?q=OS%C5%98")).json();
    expect(body.acts[0]).toMatchObject({ id: "zak:99/1963", abbreviation: expect.any(String) });
    expect(await ids("/v1/acts?q=gdpr")).toEqual(["eu:32016R0679"]);
  });

  it("keeps to a group: treaties include the old sdělení of the Sbírka zákonů", async () => {
    expect(await ids("/v1/acts?q=%C3%BAmluv&group=intl")).toEqual(["zak:209/1992"]);
    expect(await ids("/v1/acts?q=sd%C4%9Blen%C3%AD&group=intl")).toEqual(["sm:12/2005", "zak:209/1992"]);
    expect(await ids("/v1/acts?q=ob%C4%8Dansk%C3%BD&group=eu")).toEqual([]);
  });

  it("explains a bad request", async () => {
    expect((await get("/v1/acts")).status).toBe(400);
    expect((await get("/v1/acts?q=x&group=us")).status).toBe(400);
    expect((await get("/v1/acts?q=x&limit=99")).status).toBe(400);
  });
});

describe("GET /v1/status", () => {
  it("returns the per-source state", async () => {
    const body = await (await get("/v1/status")).json();
    expect(body.sources.find((s: { source: string }) => s.source === "us")).toMatchObject({
      decisions: 2,
      withText: 2,
      withDissent: 1,
      dissents: 1,
      images: 2,
      types: { nalez: 1, usneseni: 1 },
    });
    expect(Date.parse(body.asOf)).not.toBeNaN();
  });
});
