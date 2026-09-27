import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTsvector, MAX_POSITION, quoteLexeme } from "@/src/files/index/tsv";
import {
  buildTsQuery,
  foldWord,
  indexTerm,
  isExactTerm,
  luceneStem,
  queryTerm,
  queryTerms,
  snowballTail,
  STOPWORDS,
  tokenize,
} from "@/src/files/text/analyze";
import { LEGAL_TERMS, LUCENE_CZECH_STOPWORDS } from "@/src/files/text/stopwords";
import { createTestDb, type TestDb } from "./helpers/pglite";

describe("foldWord", () => {
  it("lowercases and strips diacritics", () => {
    expect(foldWord("Žluťoučký kůň úpěl ďábelské ódy")).toBe("zlutoucky kun upel dabelske ody");
    expect(foldWord("ŘÍZENÍ")).toBe("rizeni");
  });
  it("handles decomposed input and letters NFD cannot split", () => {
    expect(foldWord("smlouvách".normalize("NFD"))).toBe("smlouvach");
    expect(foldWord("Straße Łódź Ærø")).toBe("strasse lodz aero");
  });
  it("is identity on plain ASCII and empty", () => {
    expect(foldWord("abc123")).toBe("abc123");
    expect(foldWord("")).toBe("");
  });
});

describe("tokenize", () => {
  it("returns lowercase tokens with offsets into the input", () => {
    const text = "Náhrada škody (§ 2913) — viz 25 Cdo 1234/2019.";
    const tokens = tokenize(text);
    expect(tokens.map((t) => t.lower)).toEqual(["náhrada", "škody", "2913", "viz", "25", "cdo", "1234", "2019"]);
    for (const t of tokens) expect(text.slice(t.start, t.end).toLowerCase()).toBe(t.lower);
  });
  it("keeps combining marks inside a token and NFC-normalizes `lower`", () => {
    const text = "smlouvách x"; // decomposed á
    const [first] = tokenize(text);
    expect(first).toEqual({ lower: "smlouvách", start: 0, end: 10 });
  });
  it("splits on superscript digits, punctuation and hyphens", () => {
    expect(tokenize("smlouvy² e-mail don't").map((t) => t.lower)).toEqual(["smlouvy", "e", "mail", "don", "t"]);
  });
  it("counts UTF-16 offsets around astral characters", () => {
    const text = "😀 škoda";
    const [t] = tokenize(text);
    expect(t).toEqual({ lower: "škoda", start: 3, end: 8 });
  });
  it("returns nothing for empty or punctuation-only input", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize(" §§ — … ")).toEqual([]);
  });
});

describe("indexTerm", () => {
  it("stems WITH diacritics, then folds", () => {
    expect(indexTerm("smlouvách")).toBe("smlouv");
    expect(indexTerm("zaměstnavatelům")).toBe("zamestnavatel");
    expect(indexTerm("rozsudkem")).toBe("rozsudk");
    expect(indexTerm("promlčení")).toBe("promlcen");
  });
  it("passes numbers, alphanumerics and short tokens folded", () => {
    expect(indexTerm("2913")).toBe("2913");
    expect(indexTerm("2913a")).toBe("2913a");
    expect(indexTerm("č")).toBe("c");
    expect(indexTerm("ús")).toBe("us");
  });
  it("tolerates uppercase and decomposed input", () => {
    expect(indexTerm("SMLOUVÁCH")).toBe("smlouv");
    expect(indexTerm("smlouvách".normalize("NFD"))).toBe("smlouv");
  });
  it("does not stem absurdly long tokens", () => {
    const long = "á".repeat(60);
    expect(indexTerm(long)).toBe("a".repeat(60));
  });
});

describe("query side", () => {
  it("queryTerm = indexTerm for words with diacritics", () => {
    expect(queryTerm("smlouvách")).toBe(indexTerm("smlouvách"));
    expect(queryTerm("výpovědi")).toBe("vypoved");
  });
  it("queryTerm strips folded case endings for words without diacritics", () => {
    expect(queryTerm("smlouvach")).toBe("smlouv");
    expect(queryTerm("zamestnavatelem")).toBe("zamestnavatel");
    expect(queryTerm("skody")).toBe("skod");
    expect(queryTerm("rozsudek")).toBe("rozsudk");
    expect(queryTerm("vypovedi")).toBe("vypoved");
  });
  it("luceneStem keeps ≥ 3 characters and strips possessives", () => {
    expect(luceneStem("atech")).toBe("atech"); // too short for any tier
    expect(luceneStem("domech")).toBe("dom");
    expect(luceneStem("sestrin")).toBe("sestr");
    expect(luceneStem("smlouv")).toBe("smlouv"); // folded "-uv" is not the possessive "-ův"
    expect(luceneStem("proces")).toBe("proces"); // no "-es" (Snowball never strips it)
    expect(luceneStem("pan")).toBe("pan");
  });
  it("snowballTail removes the inserted -e- where Snowball does", () => {
    expect(snowballTail("rozsudek")).toBe("rozsudk");
    expect(snowballTail("pocet")).toBe("poct");
    expect(snowballTail("cirkev")).toBe("cirkv");
    expect(snowballTail("skladeb")).toBe("skladb");
    expect(snowballTail("potreb")).toBe("potreb");
    expect(snowballTail("dotek")).toBe("dotek");
    expect(snowballTail("predmet")).toBe("predmet");
    expect(snowballTail("zamestnavatel")).toBe("zamestnavatel");
  });
  it("queryTerms adds Snowball's c/k and -e- alternatives, primary first", () => {
    expect(queryTerms("soudců")).toEqual(["soudc", "soudk"]);
    expect(queryTerms("obce")).toEqual(expect.arrayContaining(["obk", "obec"]));
    expect(queryTerms("smlouvami")).toEqual(["smlouv", "smluv"]);
    expect(queryTerms("odpovědnost")).toEqual(["odpovednost"]);
  });
  it("queryTerms: exact terms, and nothing for non-Latin words", () => {
    expect(queryTerms("2913")).toEqual(["2913"]);
    expect(queryTerms("ÚS")).toEqual(["us"]);
    expect(queryTerms("право")).toEqual([]);
    expect(queryTerms("")).toEqual([]);
  });
  it("isExactTerm: digits and ≤ 2 characters", () => {
    expect(isExactTerm("2913")).toBe(true);
    expect(isExactTerm("c1")).toBe(true);
    expect(isExactTerm("na")).toBe(true);
    expect(isExactTerm("nah")).toBe(false);
  });
});

describe("STOPWORDS", () => {
  it("is Lucene's list, folded, minus legal terms", () => {
    expect(LUCENE_CZECH_STOPWORDS).toHaveLength(172);
    expect(STOPWORDS.has("ktery")).toBe(true);
    expect(STOPWORDS.has("ji")).toBe(true);
    expect(STOPWORDS.has("přičemž")).toBe(false); // folded only
    expect(STOPWORDS.has("pricemz")).toBe(true);
    for (const w of LEGAL_TERMS) expect(STOPWORDS.has(w)).toBe(false);
    for (const w of STOPWORDS) expect(w).toBe(foldWord(w));
  });
});

describe("buildTsQuery", () => {
  it("ANDs and ORs prefix terms, stopwords dropped", () => {
    const q = buildTsQuery("náhradu škody podle smlouvy");
    expect(q.and).toBe("'nahrad':* & 'skod':* & ( 'smlouv':* | 'smluv':* )");
    expect(q.or).toBe("'nahrad':* | 'skod':* | ( 'smlouv':* | 'smluv':* )");
    expect(q.terms).toEqual(["nahrad", "skod", "smlouv", "smluv"]);
    expect(q.phrases).toEqual([]);
  });
  it("one term → or is null; empty / punctuation → nothing searchable", () => {
    expect(buildTsQuery("odpovědnost")).toEqual({ and: "'odpovednost':*", or: null, terms: ["odpovednost"], phrases: [] });
    for (const input of ["", "   ", "&|!()<->:*'\"", "„“"]) {
      expect(buildTsQuery(input)).toEqual({ and: null, or: null, terms: [], phrases: [] });
    }
  });
  it("keeps stopwords when the query has nothing else", () => {
    expect(buildTsQuery("to je ono").and).toBe("'to' & 'je' & 'ono':*");
  });
  it("matches digits exactly, never as prefixes", () => {
    expect(buildTsQuery("§ 29 odst. 2").and).toBe("'29' & 'odst':* & '2'");
  });
  it("turns quoted text into a <-> phrase, stopwords kept", () => {
    const q = buildTsQuery('„náhrada škody na zdraví" zaměstnavatel');
    expect(q.and).toBe("( 'nahrad':* <-> 'skod':* <-> 'na' <-> 'zdrav':* ) & 'zamestnavatel':*");
    expect(q.phrases).toEqual([["nahrad", "skod", "na", "zdrav"]]);
  });
  it("treats an unmatched quote as plain words", () => {
    expect(buildTsQuery('škoda "náhrada').and).toBe("'skod':* & 'nahrad':*");
    expect(buildTsQuery('"a" škoda "náhrada').phrases).toEqual([["a"]]);
  });
  it("restricts weights: lex:*D, exact 'n':D; invalid letters dropped", () => {
    expect(buildTsQuery("škoda 2913", { weights: "D" }).and).toBe("'skod':*D & '2913':D");
    expect(buildTsQuery("škoda", { weights: "cba" }).and).toBe("'skod':*ABC");
    expect(buildTsQuery("škoda", { weights: "') | 'x" }).and).toBe("'skod':*");
    expect(buildTsQuery("škoda", { weights: "" }).and).toBe("'skod':*");
  });
  it("never lets operators, quotes or brackets through (injection)", () => {
    const attacks = [
      "a & b | !c:* ( ) ' \" <-> :A",
      "smlouva') | ('x",
      "škoda:*A & !náhrada",
      "x' & (SELECT 1) --",
      "\\' \\\\ '' <2> <-> ! & |",
      "\u0000škoda‮text",
    ];
    for (const attack of attacks) {
      const q = buildTsQuery(attack, { weights: "D" });
      for (const s of [q.and, q.or]) {
        if (s === null) continue;
        // Only quoted [a-z0-9] lexemes and our operators.
        expect(s).toMatch(/^(?:'[a-z0-9]+'(?::\*?[ABCD]*)?|[&|()]|<->|\s)+$/);
      }
      for (const t of q.terms) expect(t).toMatch(/^[a-z0-9]+$/);
    }
  });
  it("deduplicates repeated words and caps the operand count", () => {
    expect(buildTsQuery("škoda škody škodu").and).toBe("'skod':*");
    const many = Array.from({ length: 40 }, (_, i) => `slovo${String.fromCharCode(97 + (i % 26))}${i}`).join(" ");
    expect(buildTsQuery(many).and!.split(" & ")).toHaveLength(16);
  });
  it("bounds the input length", () => {
    const q = buildTsQuery("škoda ".repeat(10_000) + "zaměstnavatel");
    expect(q.terms).toEqual(["skod"]);
  });
});

describe("buildTsvector", () => {
  it("writes positions in order with weights, D without a letter", () => {
    expect(
      buildTsvector([
        { text: "Náhrada škody", weight: "A" },
        { text: "náhradu", weight: "C" },
        { text: "škodě", weight: "D" },
      ]),
    ).toBe("'nahrad':1A,3C 'skod':2A,4");
  });
  it("is empty for no tokens", () => {
    expect(buildTsvector([])).toBe("");
    expect(buildTsvector([{ text: " — ", weight: "C" }])).toBe("");
  });
  it("caps positions at 16383 and positions per lexeme at 256", () => {
    const text = "slovo ".repeat(MAX_POSITION + 50);
    const tsv = buildTsvector([{ text: "úvod", weight: "A" }, { text, weight: "C" }]);
    const positions = /'slov':([^ ]+)/.exec(tsv)![1].split(",");
    expect(positions).toHaveLength(256);
    const last = buildTsvector([{ text: "a ".repeat(MAX_POSITION + 5) + "soud", weight: "C" }]);
    expect(last).toContain("'soud':16383C");
  });
  it("keeps the strongest weight when capped positions collide", () => {
    const tsv = buildTsvector([
      { text: "x ".repeat(MAX_POSITION), weight: "D" },
      { text: "hlava", weight: "D" },
      { text: "hlava", weight: "B" },
    ]);
    expect(tsv).toContain("'hlav':16383B");
  });
  it("quotes lexemes safely", () => {
    expect(quoteLexeme("abc")).toBe("'abc'");
    expect(quoteLexeme("o'neil")).toBe("'o''neil'");
    expect(quoteLexeme("a\\b")).toBe("'a\\\\b'");
  });
});

// ---------------------------------------------------------------------------
// Against a real Postgres: literals parse, and query and index meet.

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, 60_000);
afterAll(async () => t?.close());

async function scalar<T>(sql: string, params: unknown[]): Promise<T> {
  const { rows } = await t.owner.query<{ v: T }>(sql, params);
  return rows[0].v;
}
const matches = (tsv: string, tsq: string) =>
  scalar<boolean>("SELECT $1::tsvector @@ to_tsquery('simple', $2) AS v", [tsv, tsq]);

describe("Postgres round trip (PGlite)", () => {
  const PARAGRAPH =
    "Zaměstnavatel odpovídá zaměstnanci za škodu vzniklou porušením právních povinností. " +
    "Náhrada škody se řídí ustanoveními o smlouvách; vlastnické právo tím není dotčeno. " +
    "Rozsudkem ze dne 12. 5. 2019 soud rozhodl o výpovědi a o promlčení nároku.";
  const FOOTNOTE = "Srov. rozsudek Nejvyššího soudu sp. zn. 25 Cdo 1234/2019 o odpovědnosti.";

  it("accepts every literal buildTsvector produces", async () => {
    const tsv = buildTsvector([
      { text: "Hlava III. Odpovědnost", weight: "A" },
      { text: PARAGRAPH, weight: "C" },
      { text: FOOTNOTE, weight: "D" },
      { text: "Straße Ærø 😀 право ﬁ", weight: "C" },
    ]);
    const round = await scalar<string>("SELECT $1::tsvector::text AS v", [tsv]);
    expect(round).toContain("'odpovedn");
    expect(round).toContain("'zamestnavatel':");
    expect(await scalar<number>("SELECT length($1::tsvector) AS v", [tsv])).toBeGreaterThan(20);
  });

  it("accepts escaped lexemes", async () => {
    expect(await scalar<string>("SELECT $1::tsvector::text AS v", [`${quoteLexeme("o'neil")}:1`])).toBe("'o''neil':1");
    expect(await scalar<string>("SELECT $1::tsvector::text AS v", [`${quoteLexeme("a\\b")}:1`])).toBe("'a\\\\b':1");
  });

  it("stores the position cap as Postgres does", async () => {
    const tsv = buildTsvector([{ text: "a ".repeat(MAX_POSITION + 5) + "soud", weight: "C" }]);
    expect(await scalar<string>("SELECT (ts_debug_pos) AS v FROM (SELECT $1::tsvector::text AS ts_debug_pos) s", [tsv])).toContain(
      "'soud':16383C",
    );
  });

  it("parses every tsquery buildTsQuery produces, including from hostile input", async () => {
    const inputs = [
      "náhradu škody",
      '"náhrada škody na zdraví" zaměstnavatel',
      "a & b | !c:* ( ) ' \" <-> :A",
      "smlouva') | ('x",
      "\\' \\\\ '' <2> <-> ! & |",
      "soudců obce smlouvami 2913 ÚS",
      "1e5 0x1f 007 abc123",
    ];
    for (const input of inputs) {
      for (const weights of [undefined, "D", "ABC"]) {
        const q = buildTsQuery(input, { weights });
        for (const s of [q.and, q.or]) {
          if (s === null) continue;
          const parsed = await scalar<string>("SELECT to_tsquery('simple', $1)::text AS v", [s]);
          expect(parsed.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("finds inflected forms typed with and without diacritics", async () => {
    const tsv = buildTsvector([{ text: PARAGRAPH, weight: "C" }]);
    const queries = [
      "náhradu škody",
      "nahradu skody",
      "zaměstnavatelem",
      "zamestnavatele",
      "smlouva",
      "smlouvami",
      "smluv",
      "odpovědnosti zaměstnavatele",
      "vlastnického práva",
      "vlastnickeho prava",
      "rozsudek",
      "rozsudku",
      "výpověď",
      "vypoved",
      "promlčením",
      "promlceni",
      '"náhradu škody"',
      '"nahrada skody"',
    ];
    for (const query of queries) {
      const q = buildTsQuery(query);
      expect({ query, hit: await matches(tsv, q.and!) }).toEqual({ query, hit: true });
    }
  });

  it("phrase order matters; unrelated words do not match", async () => {
    const tsv = buildTsvector([{ text: PARAGRAPH, weight: "C" }]);
    expect(await matches(tsv, buildTsQuery('"škody náhrada"').and!)).toBe(false);
    expect(await matches(tsv, buildTsQuery("insolvence").and!)).toBe(false);
    expect(await matches(tsv, buildTsQuery("náhrada insolvence").and!)).toBe(false);
    expect(await matches(tsv, buildTsQuery("náhrada insolvence").or!)).toBe(true);
  });

  it("digits match exactly", async () => {
    const tsv = buildTsvector([{ text: "§ 2913 odst. 2", weight: "C" }]);
    expect(await matches(tsv, buildTsQuery("2913").and!)).toBe(true);
    expect(await matches(tsv, buildTsQuery("291").and!)).toBe(false);
  });

  it("weight restriction D matches only footnote-weighted text", async () => {
    const tsv = buildTsvector([
      { text: "Náhrada škody", weight: "A" },
      { text: PARAGRAPH, weight: "C" },
      { text: FOOTNOTE, weight: "D" },
    ]);
    // "rozsudek" is in the body (Rozsudkem) and in the footnote.
    expect(await matches(tsv, buildTsQuery("rozsudek", { weights: "D" }).and!)).toBe(true);
    // "nejvyššího" only in the footnote.
    expect(await matches(tsv, buildTsQuery("nejvyšší", { weights: "D" }).and!)).toBe(true);
    expect(await matches(tsv, buildTsQuery("nejvyšší", { weights: "ABC" }).and!)).toBe(false);
    // "zaměstnavatel" only in the body.
    expect(await matches(tsv, buildTsQuery("zaměstnavatel", { weights: "D" }).and!)).toBe(false);
    expect(await matches(tsv, buildTsQuery("zaměstnavatel", { weights: "ABC" }).and!)).toBe(true);
  });

  it("works as a stored, GIN-indexed column with ts_rank_cd", async () => {
    await t.owner.query("CREATE TEMP TABLE tsv_probe (id int, tsv tsvector)");
    await t.owner.query("CREATE INDEX ON tsv_probe USING gin (tsv)");
    await t.owner.query("INSERT INTO tsv_probe VALUES (1, $1::tsvector), (2, $2::tsvector)", [
      buildTsvector([{ text: PARAGRAPH, weight: "C" }]),
      buildTsvector([{ text: "Insolvenční řízení dlužníka.", weight: "C" }]),
    ]);
    const { rows } = await t.owner.query<{ id: number; r: number }>(
      "SELECT id, ts_rank_cd('{0.05,0.12,0.2,1.0}', tsv, q) AS r FROM tsv_probe, to_tsquery('simple', $1) q WHERE tsv @@ q",
      [buildTsQuery("nahradu skody").and],
    );
    expect(rows.map((r) => r.id)).toEqual([1]);
    expect(rows[0].r).toBeGreaterThan(0);
  });
});
