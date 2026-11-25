import path from "node:path";
import { gzipSync } from "node:zlib";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import type { Db } from "@/src/mirror/db/client";
import { saveDecision } from "@/src/mirror/db/store";
import { createMirrorApi } from "@/src/mirror/api/server";
import { BM25_CANDIDATES, COURT_EXACT_MAX, searchDecisions } from "@/src/mirror/api/queries";
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

describe("GET /v1/search: ranking, courts, lanes", () => {
  beforeAll(async () => {
    const db: Db = {
      query: (text, params) => pg.query(text, params) as never,
      transaction: (fn) => pg.transaction((tx) => fn({ query: (text, params) => tx.query(text, params) as never })),
    };
    const body = (n: number) => `Stěžovatel namítá, že soudy pominuly vyvažování kvádrů. ${"Vyvažování kvádrů je klíčové. ".repeat(n)}Konec.`;
    await saveDecision(db, record({ sourceId: "1-20-25_1", caseNumber: "I. ÚS 20/25", decisionType: "usneseni", decidedOn: "2025-05-01", text: { body: body(2), source: "us:gettext-hidden" } }));
    await saveDecision(db, record({ sourceId: "3-30-25_1", caseNumber: "III. ÚS 30/25", decisionType: "nalez", decidedOn: "2025-02-01", text: { body: body(1), source: "us:gettext-hidden" } }));
    const nss = { source: "nss" as const, decisionType: "rozsudek" as const, url: "https://vyhledavac.nssoud.cz/DokumentDetail/Index/1" };
    await saveDecision(db, record({ ...nss, sourceId: "900001", caseNumber: "1 As 1/2025", court: "Nejvyšší správní soud (tříčlenný senát NSS)", decidedOn: "2025-04-01", text: { body: body(1), source: "nss:text" } }));
    await saveDecision(db, record({ ...nss, sourceId: "900002", caseNumber: "30 A 2/2024", court: "Krajský soud v Brně", decidedOn: "2025-06-01", text: { body: body(1), source: "nss:text" } }));
  });
  const q = encodeURIComponent("vyvažování kvádrů");
  const ids = async (extra: string) => ((await (await get(`/v1/search?q=${q}${extra}`)).json()).hits as Array<{ id: string }>).map((h) => h.id);

  it("puts a nález before an usnesení that matches as well", async () => {
    expect(await ids("&source=us")).toEqual(["3-30-25_1", "1-20-25_1"]);
  });

  it("leaves out the regional administrative courts unless asked for or named", async () => {
    expect(await ids("&source=nss")).toEqual(["900001"]);
    expect((await ids("&source=nss&regional=1")).sort()).toEqual(["900001", "900002"]);
    expect(await ids(`&source=nss&court=${encodeURIComponent("Krajský soud")}`)).toEqual(["900002"]);
  });

  it("sorts by date on request", async () => {
    expect(await ids("&source=us&sort=newest")).toEqual(["1-20-25_1", "3-30-25_1"]);
  });

  it("answers one lane per court", async () => {
    const body = await (await get(`/v1/search?q=${q}&per_source=1`)).json();
    expect(Object.keys(body.lanes).sort()).toEqual(["justice", "ns", "nss", "us"]);
    expect(body.lanes.us.hits.map((h: { id: string }) => h.id)).toEqual(["3-30-25_1"]);
    expect(body.lanes.nss.hits.map((h: { id: string }) => h.id)).toEqual(["900001"]);
    expect(body.lanes.ns.hits).toEqual([]);
    const two = await (await get(`/v1/search?q=${q}&per_source=5&source=us,nss`)).json();
    expect(Object.keys(two.lanes).sort()).toEqual(["nss", "us"]);
  });

  it("rejects a bad sort or lane size", async () => {
    expect((await get(`/v1/search?q=${q}&sort=random`)).status).toBe(400);
    expect((await get(`/v1/search?q=${q}&per_source=0`)).status).toBe(400);
  });
});

describe("GET /v1/search: court_code (justice)", () => {
  const justice = { source: "justice" as const, decisionType: "rozsudek" as const, url: "https://rozhodnuti.justice.cz/rozhodnuti/?id=x" };
  const body = "Žalobce se domáhal náhrady za zmeškaný dostavník. ".repeat(6);
  beforeAll(async () => {
    const db: Db = {
      query: (text, params) => pg.query(text, params) as never,
      transaction: (fn) => pg.transaction((tx) => fn({ query: (text, params) => tx.query(text, params) as never })),
    };
    const save = (sourceId: string, court: string, ecli: string | null, caseNumber: string, decidedOn: string) =>
      saveDecision(db, record({ ...justice, sourceId, court, ecli, caseNumber, caseNumbers: [caseNumber], decidedOn, text: { body, source: "justice:finaldoc" } }));
    await save("j-ksbr", "Krajský soud v Brně", "ECLI:CZ:KSBR:2024:15.Co.10.2024.1", "15 Co 10/2024", "2024-05-01");
    await save("j-ksbrji", "Krajský soud v Brně", "ECLI:CZ:KSBRJI:2025:54.Co.20.2025.1", "54 Co 20/2025", "2025-03-01");
    await save("j-ospv", "Okresní soud v Prostějově", "ECLI:CZ:OSPV:2025:9.C.311.2024.1", "9 C 311/2024", "2025-02-07");
    await save("j-none", "Krajský soud v Brně", null, "15 Co 99/2024", "2024-06-01");
    await save("j-bad", "Obvodní soud pro Prahu 2", "MSP-8/2022-OINS-SRZT/1", "15 C 7/2024", "2024-06-02");
    await save("j-unknown", "(nezadán)", "", "0 OINS 8/2022", "2022-06-23");
  });
  const q = encodeURIComponent("zmeškaný dostavník");
  const ids = async (extra: string) => ((await (await get(`/v1/search?q=${q}&source=justice${extra}`)).json()).hits as Array<{ id: string }>).map((h) => h.id).sort();

  it("keeps the decisions of the courts named: by the ECLI's code, and by the court's name where the ECLI is missing or no ECLI", async () => {
    expect(await ids("")).toEqual(["j-bad", "j-ksbr", "j-ksbrji", "j-none", "j-ospv", "j-unknown"]);
    expect(await ids("&court_code=KSBR")).toEqual(["j-ksbr", "j-none"]);
    expect(await ids("&court_code=KSBR,KSBRJI")).toEqual(["j-ksbr", "j-ksbrji", "j-none"]);
    expect(await ids("&court_code=ksbr&court_code=OSPV")).toEqual(["j-ksbr", "j-none", "j-ospv"]);
    expect(await ids("&court_code=OSPH02")).toEqual(["j-bad"]);
    expect(await ids("&court_code=OSUH")).toEqual([]);
  });

  it("combines with dates, the type and a spisová značka", async () => {
    expect(await ids("&court_code=KSBR,KSBRJI&from=2025-01-01")).toEqual(["j-ksbrji"]);
    expect(await ids("&court_code=KSBR,KSBRJI&type=usneseni")).toEqual([]);
    const byCase = async (code: string) =>
      ((await (await get(`/v1/search?case=${encodeURIComponent("9 C 311/2024")}&source=justice&court_code=${code}`)).json()).hits as Array<{ id: string }>).map((h) => h.id);
    expect(await byCase("OSPV")).toEqual(["j-ospv"]);
    expect(await byCase("KSBR")).toEqual([]);
  });

  it("takes codes only, and only for justice", async () => {
    expect((await get(`/v1/search?q=${q}&source=justice&court_code=${encodeURIComponent("KSBR'; DROP")}`)).status).toBe(400);
    expect((await get(`/v1/search?q=${q}&court_code=KSBR`)).status).toBe(400);
    expect((await get(`/v1/search?q=${q}&source=ns,justice&court_code=KSBR`)).status).toBe(400);
  });

  it("the index of 0022 is on the column the filter uses, and 0021's is gone", async () => {
    const { rows } = await pg.query<{ indexname: string; indexdef: string }>("SELECT indexname, indexdef FROM pg_indexes WHERE indexname IN ('decision_court_code', 'decision_justice_court_code')");
    expect(rows.map((r) => r.indexname)).toEqual(["decision_court_code"]);
    expect(rows[0].indexdef).toMatch(/\(court_code, decided_on\) WHERE \(source = 'justice'(::text)?\)/);
  });

  it("the trigger keeps court_code with the row: set on insert, changed with the ECLI, empty outside justice", async () => {
    const code = async (id: string) => (await pg.query<{ court_code: string | null }>("SELECT court_code FROM mirror.decision WHERE source_id = $1", [id])).rows[0].court_code;
    expect(await code("j-ospv")).toBe("OSPV");
    expect(await code("j-unknown")).toBeNull();
    await pg.query("UPDATE mirror.decision SET ecli = 'ECLI:CZ:OSUH:2025:9.C.311.2024.1' WHERE source_id = 'j-ospv'");
    expect(await code("j-ospv")).toBe("OSUH");
    await pg.query("UPDATE mirror.decision SET ecli = 'ECLI:CZ:OSPV:2025:9.C.311.2024.1' WHERE source_id = 'j-ospv'");
    expect((await pg.query<{ n: number }>("SELECT count(*)::int AS n FROM mirror.decision WHERE source <> 'justice' AND court_code IS NOT NULL")).rows[0].n).toBe(0);
  });
});

describe("searchDecisions with BM25: court codes", () => {
  type Call = { text: string; params: unknown[] };
  const row = { source: "justice", source_id: "j-1", case_number: "1 C 1/2025", court: "Okresní soud v Prostějově", decision_type: "rozsudek", category: null, decided_on: "2025-01-01", published_on: null, ecli: "ECLI:CZ:OSPV:2025:1.C.1.2025.1", url: "u", score: 1, char_start: 0, chunk: "zmeškaný dostavník", dissent_starts: null };
  function fake(courtIds: number[], bm25Rows: unknown[] = []) {
    const calls: Call[] = [];
    const db = {
      async query(text: string, params: unknown[] = []) {
        calls.push({ text, params });
        if (text.includes("pdb.score")) return { rows: bm25Rows };
        if (text.startsWith("SELECT d.id::text")) return { rows: courtIds.map((id) => ({ id: String(id) })) };
        return { rows: [row] };
      },
    };
    return { db: db as never, calls };
  }
  const input = { q: "zmeškaný dostavník", sources: ["justice" as const], courtCodes: ["OSPV"], from: "2025-01-01", bm25: true };

  it("filters BM25's candidates by the ECLI's court, the codes as a parameter", async () => {
    const { db, calls } = fake([]);
    await searchDecisions(db, input);
    const first = calls[0];
    expect(first.text).toContain("d.source = 'justice' AND d.court_code = ANY($");
    expect(first.text).toContain(`LIMIT ${BM25_CANDIDATES}`);
    expect(first.text).not.toContain("OSPV");
    expect(first.params).toContainEqual(["OSPV"]);
  });

  it("searches a small court whole when the candidates fall short", async () => {
    const { db, calls } = fake([11, 12]);
    const result = await searchDecisions(db, input);
    const lookup = calls.find((c) => c.text.startsWith("SELECT d.id::text"))!;
    expect(lookup.params).toEqual([["OSPV"], "2025-01-01", null, null, COURT_EXACT_MAX + 1]);
    const exact = calls.at(-1)!;
    expect(exact.text).toContain("c.decision_id = ANY($14::bigint[])");
    expect(exact.params[12]).toEqual(["OSPV"]);
    expect(exact.params[13]).toEqual([11, 12]);
    expect(result.hits.map((h) => h.id)).toEqual(["j-1"]);
    expect(result.channel).toBe("and");
  });

  it("leaves a big court to BM25, and asks nothing more when the page is full", async () => {
    const big = fake(Array.from({ length: COURT_EXACT_MAX + 1 }, (_, i) => i));
    expect((await searchDecisions(big.db, input)).hits).toEqual([]);
    expect(big.calls.filter((c) => c.text.includes("decision_chunk c, q"))).toHaveLength(0);
    const full = fake([1], [row]);
    await searchDecisions(full.db, { ...input, limit: 1 });
    expect(full.calls).toHaveLength(1);
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

describe("structure and the search in výroky", () => {
  const nsBody = [
    "Nejvyšší soud rozhodl v senátě ve věci žalobce A. proti žalovanému B., t a k t o :",
    "",
    "I. Řízení se pro zpětvzetí dovolání zastavuje.",
    "",
    "O d ů v o d n ě n í :",
    "",
    "1. Žalobce podal dovolání proti rozsudku o trojúhelníkovém zápočtu.",
    "2. Dovolání vzal zpět.",
  ].join("\n");

  beforeAll(async () => {
    const db: Db = {
      query: (text, params) => pg.query(text, params) as never,
      transaction: (fn) => pg.transaction((tx) => fn({ query: (text, params) => tx.query(text, params) as never })),
    };
    await saveDecision(
      db,
      record({
        source: "ns",
        sourceId: "AB000000000000000000000000000001",
        url: "https://sbirka.nsoud.cz/x",
        court: "Nejvyšší soud",
        caseNumber: "33 Cdo 1/2025",
        caseNumbers: ["33 Cdo 1/2025"],
        decisionType: "usneseni",
        decidedOn: "2025-07-01",
        text: { body: nsBody, source: "ns:webprint" },
      }),
    );
  });

  it("gives the decision's sections and numbered paragraphs", async () => {
    const d = await (await get("/v1/decisions/ns/AB000000000000000000000000000001")).json();
    expect(d.structure.sections.map((s: { kind: string }) => s.kind)).toEqual(["zahlavi", "vyrok", "oduvodneni"]);
    expect(d.structure.paragraphs.map((p: { num: string }) => p.num)).toEqual(["1", "2"]);
    const vyrok = d.structure.sections[1];
    expect(nsBody.slice(vyrok.start, vyrok.end)).toBe("I. Řízení se pro zpětvzetí dovolání zastavuje.");
  });

  it("finds words in the výrok only when asked", async () => {
    const ids = async (q: string, extra = "&in=vyrok") =>
      ((await (await get(`/v1/search?q=${encodeURIComponent(q)}${extra}`)).json()).hits as Array<{ id: string }>).map((h) => h.id);
    expect(await ids("zpětvzetí")).toEqual(["AB000000000000000000000000000001"]);
    expect(await ids("trojúhelníkovém")).toEqual([]);
    expect(await ids("trojúhelníkovém", "")).toEqual(["AB000000000000000000000000000001"]);
    const hit = (await (await get(`/v1/search?q=zpětvzetí&in=vyrok`)).json()).hits[0];
    expect(hit.excerpt).toBe("I. Řízení se pro zpětvzetí dovolání zastavuje.");
  });

  it("rejects an identifier in výroky and an unknown part", async () => {
    expect((await get(`/v1/search?q=${encodeURIComponent("33 Cdo 1/2025")}&in=vyrok`)).status).toBe(400);
    expect((await get("/v1/search?q=x&in=oduvodneni")).status).toBe(400);
  });
});

describe("filters outside the index, paging and listings (GET /v1/search)", () => {
  const ids = async (query: string): Promise<string[]> => ((await (await get(`/v1/search?${query}`)).json()).hits as Array<{ id: string }>).map((h) => h.id);

  it("without words the filters list the decisions that pass them, newest first, with their count", async () => {
    const all = await (await get("/v1/search?source=us")).json();
    expect(all.total).toBeGreaterThanOrEqual(2);
    expect(all.hits.map((h: { date: string }) => h.date)).toEqual([...all.hits.map((h: { date: string }) => h.date)].sort().reverse());
    const nalezy = await (await get("/v1/search?source=us&type=nalez")).json();
    expect(nalezy.channel).toBe("ident");
    expect(nalezy.total).toBe(nalezy.hits.length);
    expect(nalezy.hits.every((h: { form: string }) => h.form === "nalez")).toBe(true);
    const ours = nalezy.hits.find((h: { id: string }) => h.id === "4-296-24_1");
    // The právní věta is the excerpt where the decision has one.
    expect(ours.excerpt).toContain("Promlčení");
    const dated = await (await get("/v1/search?source=us&from=2025-06-18&to=2025-06-18")).json();
    expect(dated.hits.map((h: { id: string }) => h.id)).toContain("4-296-24_1");
    expect(dated.hits.every((h: { date: string }) => h.date === "2025-06-18")).toBe(true);
  });

  it("several forms at once; a form nobody has lists nothing", async () => {
    expect(await ids("source=us&type=nalez,usneseni&from=2025-01-01&to=2025-12-31")).toEqual(expect.arrayContaining(["4-296-24_1", "1-10-25_1"]));
    expect((await (await get("/v1/search?source=us&type=stanovisko")).json()).total).toBe(0);
    expect((await get("/v1/search?source=us&type=nalez,verdikt")).status).toBe(400);
  });

  it("pages with offset — a listing and a search alike", async () => {
    const first = await ids("source=us&from=2025-01-01&to=2025-12-31&limit=1");
    const second = await ids("source=us&from=2025-01-01&to=2025-12-31&limit=1&offset=1");
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(second[0]).not.toBe(first[0]);
    const words = "q=" + encodeURIComponent("promlčení");
    const both = await ids(`${words}&source=us`);
    expect(both.length).toBeGreaterThanOrEqual(2);
    expect(await ids(`${words}&source=us&limit=1&offset=1`)).toEqual([both[1]]);
    expect((await get(`/v1/search?${words}&offset=999999`)).status).toBe(400);
  });

  it("a cited provision is a filter: alone it lists the decisions citing it, with words it narrows the search", async () => {
    const cite = "cite=" + encodeURIComponent("§ 2913 odst. 1 zákona č. 89/2012 Sb.");
    const listed = await (await get(`/v1/search?${cite}`)).json();
    expect(listed).toMatchObject({ total: 1 });
    expect(listed.hits[0].id).toBe("1-10-25_1");
    // The excerpt is the text around the citation, not the opening of the decision.
    expect(listed.hits[0].excerpt).toContain("§ 2913 odst. 1 písm. b)");
    expect(await ids("act=89/2012&provision=par:2913")).toEqual(["1-10-25_1"]);
    expect(await ids("act=89/2012")).toEqual(["1-10-25_1"]);
    // Both decisions speak of promlčení; only one cites § 2913.
    expect(await ids(`q=${encodeURIComponent("promlčení")}&${cite}`)).toEqual(["1-10-25_1"]);
    expect(await ids(`q=${encodeURIComponent("promlčení")}&act=89/2012&provision=par:2914`)).toEqual([]);
    expect((await get("/v1/search?provision=par:2913")).status).toBe(400);
    expect((await get("/v1/search?act=nonsense")).status).toBe(400);
  });

  it("own_case is THAT decision, and combines with words — case= also finds the ones citing it", async () => {
    const own = "own_case=" + encodeURIComponent("IV. ÚS 296/24");
    expect(await ids(own)).toEqual(["4-296-24_1"]);
    expect(await ids(`${own}&q=${encodeURIComponent("promlčení")}`)).toEqual(["4-296-24_1"]);
    expect(await ids(`${own}&q=${encodeURIComponent("zmeškaný dostavník")}`)).toEqual([]);
    expect(await ids("own_case=" + encodeURIComponent("ECLI:CZ:US:2025:4.US.296.24.1"))).toEqual(["4-296-24_1"]);
    // A značka nobody carries matches nothing — never "no filter".
    expect((await (await get("/v1/search?own_case=" + encodeURIComponent("I. ÚS 9999/99"))).json()).total).toBe(0);
  });

  it("the registry is the letters of the spisová značka; the web date is a range", async () => {
    expect(await ids("source=us&registry=" + encodeURIComponent("ÚS"))).toEqual(expect.arrayContaining(["4-296-24_1", "1-10-25_1"]));
    expect((await (await get("/v1/search?source=us&registry=Cdo")).json()).total).toBe(0);
    expect((await get("/v1/search?source=us&registry=" + encodeURIComponent("Cdo; DROP"))).status).toBe(400);
    // Nothing in the fixture carries a publication date.
    expect((await (await get("/v1/search?source=us&published_from=2020-01-01")).json()).total).toBe(0);
    expect((await get("/v1/search?source=us&published_from=yesterday")).status).toBe(400);
  });

  it("refuses a call with nothing to search for and nothing to filter by, and unknown values of the new parameters", async () => {
    expect((await get("/v1/search")).status).toBe(400);
    expect((await get("/v1/search?limit=5")).status).toBe(400);
    expect((await get("/v1/search?source=us&match=fuzzy")).status).toBe(400);
    expect((await get("/v1/search?source=us&newest_by=name")).status).toBe(400);
    expect((await get("/v1/search?source=us&court_class=okresni")).status).toBe(400);
  });
});

describe("GET /v1/decisions/:source/:id/citations", () => {
  it("links the citing decision and the cited one, both ways", async () => {
    const citing = await (await get("/v1/decisions/us/1-10-25_1/citations")).json();
    const cited = citing.cites.find((c: { display: string }) => c.display === "IV. ÚS 296/24");
    expect(cited).toMatchObject({ key: "sz:4us296-2024", mentions: 1 });
    expect(cited.decisions.map((d: { id: string }) => d.id)).toEqual(["4-296-24_1"]);
    // Its own sp. zn. is no citation.
    expect(citing.cites.some((c: { display: string }) => c.display === "I. ÚS 10/25")).toBe(false);

    const target = await (await get("/v1/decisions/us/4-296-24_1/citations")).json();
    expect(target.citedBy.total).toBe(1);
    expect(target.citedBy.hits[0]).toMatchObject({ source: "us", id: "1-10-25_1", caseNumber: "I. ÚS 10/25", mentions: 1 });
    expect((await (await get("/v1/decisions/us/4-296-24_1/citations?source=ns")).json()).citedBy.total).toBe(0);
  });

  it("counts the citing decisions by court, orders them on request and shows where each names the decision", async () => {
    const target = await (await get("/v1/decisions/us/4-296-24_1/citations")).json();
    expect(target.citedBy).toMatchObject({ total: 1, bySource: { us: 1 }, order: "newest" });
    expect(typeof target.citedBy.top).toBe("number");
    // The citing decision's own text, around its first mention of the cited značka.
    expect(target.citedBy.hits[0].excerpt).toContain("296/24");
    const byCourts = await (await get("/v1/decisions/us/4-296-24_1/citations?order=courts")).json();
    expect(byCourts.citedBy).toMatchObject({ total: 1, order: "courts" });
    expect(byCourts.citedBy.hits.map((h: { id: string }) => h.id)).toEqual(["1-10-25_1"]);
    // A court filter narrows the counts with the list.
    expect((await (await get("/v1/decisions/us/4-296-24_1/citations?source=ns")).json()).citedBy.bySource).toEqual({});
    expect((await get("/v1/decisions/us/4-296-24_1/citations?order=oldest")).status).toBe(400);
  });

  it("the decision itself says who cites it (page 1), and a hit list its length and citing count", async () => {
    const cited = await (await get("/v1/decisions/us/4-296-24_1")).json();
    expect(cited.citedBy).toMatchObject({ total: 1, bySource: { us: 1 } });
    expect((await (await get("/v1/decisions/us/1-10-25_1")).json()).citedBy).toMatchObject({ total: 0, bySource: {} });
    const search = await (await get("/v1/search?q=" + encodeURIComponent("spravedlivého procesu promlčení"))).json();
    expect(search.hits[0]).toMatchObject({ id: "4-296-24_1", citedBy: 1, chars: nalezBody.length });
    const lanes = await (await get("/v1/search?per_source=2&q=" + encodeURIComponent("spravedlivého procesu promlčení"))).json();
    expect(lanes.lanes.us.hits[0]).toMatchObject({ id: "4-296-24_1", citedBy: 1, chars: nalezBody.length });
  });

  it("GET /v1/by-case names the decision carrying the značka, not the ones citing it", async () => {
    const own = await (await get(`/v1/by-case?case=${encodeURIComponent("IV. ÚS 296/24")}`)).json();
    expect(own.decisions.map((d: { id: string }) => d.id)).toEqual(["4-296-24_1"]);
    expect((await (await get(`/v1/by-case?case=${encodeURIComponent("IV. ÚS 296/24")}&source=ns`)).json()).decisions).toEqual([]);
    expect((await (await get("/v1/by-case?case=nic")).json()).decisions).toEqual([]);
    expect((await get("/v1/by-case")).status).toBe(400);
  });

  it("answers 404 for an unknown decision and 400 for bad paging", async () => {
    expect((await get("/v1/decisions/us/nope/citations")).status).toBe(404);
    expect((await get("/v1/decisions/us/4-296-24_1/citations?limit=0")).status).toBe(400);
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

  it("reads an act cited by name — the way the tools send EU law and the treaties", async () => {
    const byName = await (await get(`/v1/provisions?cite=${encodeURIComponent("čl. 36 odst. 1 Listiny")}&sort=cited`)).json();
    expect(byName).toMatchObject({ act: "zak:2/1993", provision: "cl:36/o1", total: 1, sortedBy: "cited" });
    // An EU act nobody in the fixture cites: resolved to its CELEX id, and an empty list rather than an error.
    const gdpr = await (await get(`/v1/provisions?cite=${encodeURIComponent("čl. 6 odst. 1 písm. f) nařízení (EU) 2016/679")}`)).json();
    expect(gdpr).toMatchObject({ act: "eu:32016R0679", provision: "cl:6/o1/pf", total: 0 });
    expect((await (await get(`/v1/provisions?cite=${encodeURIComponent("čl. 267 SFEU")}`)).json()).act).toBe("eu:12016E/TXT");
    expect((await (await get(`/v1/provisions?cite=${encodeURIComponent("čl. 8 směrnice 2004/48/ES")}`)).json()).act).toBe("eu:32004L0048");
  });

  it("orders by citations on request and gives each hit its length and citing count", async () => {
    const newest = await (await get("/v1/provisions?act=89/2012&provision=par:2913")).json();
    expect(newest.sortedBy).toBe("newest");
    expect(newest.hits[0]).toMatchObject({ id: "1-10-25_1", citedBy: 0 });
    expect(newest.hits[0].chars).toBeGreaterThan(0);
    const cited = await (await get("/v1/provisions?act=89/2012&provision=par:2913&sort=cited")).json();
    expect(cited).toMatchObject({ total: 1, sortedBy: "cited" });
    expect(cited.hits[0]).toMatchObject({ id: "1-10-25_1", citedBy: 0 });
    expect(cited.hits[0].excerpt).toContain("§ 2913 odst. 1 písm. b)");
    expect((await get("/v1/provisions?act=89/2012&provision=par:2913&sort=oldest")).status).toBe(400);
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
