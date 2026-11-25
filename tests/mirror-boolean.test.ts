import { describe, expect, it } from "vitest";
import { BooleanSyntaxError, PROXIMITY_WORDS, booleanSql, hasOperators, parseBoolean, positiveText } from "@/src/mirror/api/boolean";
import { UnsupportedSearch, searchDecisions } from "@/src/mirror/api/queries";

/**
 * Search operators in the mirror (src/mirror/api/boolean.ts). The mirror used
 * to read `"smluvní pokuta" NOT nájem` as words to find and answered with a
 * decision on nájemné; such queries then went to the live court. Every SQL
 * shape asserted here was run against the production index (pg_search 0.26.1,
 * 11/2026): PGlite has no BM25, so these tests pin the statement, not its rows.
 */

const sql = (query: string): { text: string; params: unknown[] } => {
  const params: unknown[] = [];
  return { text: booleanSql(parseBoolean(query), "t.body", params), params };
};

describe("hasOperators", () => {
  it("operator words in capitals, brackets and a trailing * — outside quotation marks", () => {
    for (const query of ['"smluvní pokuta" NOT nájem', "nájem AND výpověď", "a OR b", "nájem*", "(nájem)", "újma NEAR pozůstalý", "a SENTENCE b", "a PARAGRAPH b"]) {
      expect(hasOperators(query), query).toBe(true);
    }
    for (const query of ["výpověď z nájmu bytu", '"náhrada újmy" pozůstalým', "or not and near", '"A NOT B (x*)" výklad', "„smluvní pokuta“ moderace"]) {
      expect(hasOperators(query), query).toBe(false);
    }
  });
});

describe("parseBoolean", () => {
  it("adjacent terms are ANDed, bare words side by side are one 'every word' leaf", () => {
    expect(parseBoolean("výpověď nájmu NOT družstvo")).toEqual({
      kind: "and",
      nodes: [{ kind: "words", text: "výpověď nájmu" }, { kind: "not", node: { kind: "words", text: "družstvo" } }],
    });
    expect(parseBoolean('"smluvní pokuta" AND moderace')).toEqual({
      kind: "and",
      nodes: [{ kind: "phrase", text: "smluvní pokuta" }, { kind: "words", text: "moderace" }],
    });
  });

  it("NOT binds tighter than AND, AND tighter than OR; brackets group", () => {
    expect(parseBoolean("a OR b AND NOT c")).toEqual({
      kind: "or",
      nodes: [{ kind: "words", text: "a" }, { kind: "and", nodes: [{ kind: "words", text: "b" }, { kind: "not", node: { kind: "words", text: "c" } }] }],
    });
    expect(parseBoolean("(a OR b) c")).toEqual({
      kind: "and",
      nodes: [{ kind: "or", nodes: [{ kind: "words", text: "a" }, { kind: "words", text: "b" }] }, { kind: "words", text: "c" }],
    });
  });

  it("NEAR / SENTENCE / PARAGRAPH take the terms on their two sides, with their reach in words", () => {
    expect(parseBoolean("újma NEAR pozůstalý")).toEqual({ kind: "near", left: { text: "újma", prefix: false }, right: { text: "pozůstalý", prefix: false }, reach: PROXIMITY_WORDS.NEAR });
    expect(parseBoolean('"bezdůvodné obohacení" SENTENCE promlčení')).toMatchObject({ kind: "near", reach: PROXIMITY_WORDS.SENTENCE });
    expect(parseBoolean("promlč* PARAGRAPH námitka")).toMatchObject({ kind: "near", left: { text: "promlč", prefix: true }, reach: PROXIMITY_WORDS.PARAGRAPH });
    // The word before the operator's left side is a term of its own.
    expect(parseBoolean("nájem újma NEAR pozůstalý")).toMatchObject({ kind: "and", nodes: [{ kind: "words", text: "nájem" }, { kind: "near" }] });
  });

  it("the NS box's ranking operators are not searched for as words: TERMWEIGHT n and EXACTCASE are dropped, ACCRUE is OR", () => {
    expect(hasOperators("TERMWEIGHT 80 moderace pokuta")).toBe(true);
    expect(parseBoolean("TERMWEIGHT 80 moderace pokuta")).toEqual({ kind: "words", text: "moderace pokuta" });
    expect(parseBoolean("EXACTCASE Listina NOT charta")).toMatchObject({ kind: "and", nodes: [{ kind: "words", text: "Listina" }, { kind: "not" }] });
    expect(parseBoolean("nájem ACCRUE pacht")).toEqual({ kind: "or", nodes: [{ kind: "words", text: "nájem" }, { kind: "words", text: "pacht" }] });
  });

  it("says what is wrong, in the reader's terms", () => {
    const refused = (query: string): string => {
      try {
        parseBoolean(query);
      } catch (error) {
        expect(error).toBeInstanceOf(BooleanSyntaxError);
        return (error as Error).message;
      }
      throw new Error(`"${query}" was read`);
    };
    expect(refused("nájem AND (výpověď")).toContain("a bracket is not closed");
    expect(refused("nájem)")).toContain("closed that was never opened");
    expect(refused("nájem AND")).toContain("ends where a word");
    expect(refused("AND nájem")).toContain("AND stands where");
    expect(refused("NOT nájem")).toContain("NOT needs something to find");
    expect(refused("NOT a NOT b")).toContain("NOT needs something to find");
    expect(refused("ná* ")).toContain("at least 3 letters");
    expect(refused("*nájem")).toContain("only as * at the end");
    expect(refused("(a OR b) NEAR c")).toContain("NEAR takes a word");
    expect(refused('promlč* NEAR "vznesená námitka"')).toContain("a single word on the other side");
    expect(refused(Array.from({ length: 30 }, (_, i) => `w${i} OR`).join(" ") + " x")).toContain("more than 24 terms");
  });

  it("positiveText is what the query asks to find — the excerpt and its marks never show what was excluded", () => {
    expect(positiveText(parseBoolean('"smluvní pokuta" NOT nájem'))).toBe("smluvní pokuta");
    expect(positiveText(parseBoolean("nájem AND (výpověď OR odstoupení) NOT družstv*"))).toBe("nájem výpověď odstoupení");
    expect(positiveText(parseBoolean("promlč* NEAR námitka"))).toBe("promlč námitka");
  });
});

describe("booleanSql", () => {
  it("every piece of the reader's text is a bound parameter; only operators and brackets are SQL", () => {
    expect(sql('"smluvní pokuta" NOT nájem')).toEqual({
      text: "(t.body ### $1::text AND NOT (t.body &&& $2::text))",
      params: ["smluvní pokuta", "nájem"],
    });
    expect(sql("nájem AND (výpověď OR odstoupení)")).toEqual({
      text: "(t.body &&& $1::text AND (t.body &&& $2::text OR t.body &&& $3::text))",
      params: ["nájem", "výpověď", "odstoupení"],
    });
    const hostile = sql(`"x'); DROP TABLE mirror.decision; --" NOT y`);
    expect(hostile.text).toBe("(t.body ### $1::text AND NOT (t.body &&& $2::text))");
    expect(hostile.params[0]).toBe("x'); DROP TABLE mirror.decision; --");
  });

  it("a prefix is a pattern over the stored terms (folded) — and the word as written, whose own stem the pattern may miss", () => {
    expect(sql("Nájem*")).toEqual({ text: "(t.body @@@ pdb.regex($1::text) OR t.body &&& $2::text)", params: ["najem.*", "Nájem"] });
    // Nothing of the prefix but letters and digits reaches the pattern.
    expect(sql("pro.ml+č*").params[0]).toBe("promlc.*");
  });

  it("proximity: the phrase operator with slack for words and phrases, a clause of single terms when a side is a prefix", () => {
    expect(sql("výpověď NEAR nájmu")).toEqual({ text: "t.body ### $1::text::pdb.slop(10)", params: ["výpověď nájmu"] });
    expect(sql('"bezdůvodné obohacení" SENTENCE promlčení').text).toBe("t.body ### $1::text::pdb.slop(25)");
    expect(sql("promlč* NEAR námitka")).toEqual({
      text: "t.body @@@ pdb.proximity(pdb.prox_regex($1::text, 200), 10, pdb.prox_term(($2::text::pdb.simple('stemmer=czech', 'ascii_folding=true')::text[])[1]))",
      params: ["promlc.*", "námitka"],
    });
  });

  it("refuses an OR whose side only excludes: 'a OR NOT b' is nearly every decision", () => {
    expect(() => sql("nájem OR NOT družstvo")).toThrow(/NOT cannot stand alone on one side of OR/);
    expect(sql("nájem OR (výpověď NOT družstvo)").text).toBe("(t.body &&& $1::text OR (t.body &&& $2::text AND NOT (t.body &&& $3::text)))");
  });
});

describe("searchDecisions with operators", () => {
  const capture = () => {
    const calls: Array<{ text: string; params: unknown[] }> = [];
    return { calls, db: { query: async (text: string, params: unknown[]) => (calls.push({ text, params }), { rows: [] }) } };
  };

  it("is ONE BM25 statement: the tree as the body predicate, the filters beside it, no 'any word' second try", async () => {
    const { db, calls } = capture();
    const result = await searchDecisions(db as never, { q: '"smluvní pokuta" NOT nájem', sources: ["ns"], from: "2014-01-01", limit: 5, bm25: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain("$1::text IS NOT NULL AND (t.body ### $4::text AND NOT (t.body &&& $5::text))");
    expect(calls[0].text).toContain("t.source = ANY($6::text[])");
    expect(calls[0].text).toContain("pdb.score(t.decision_id)");
    // $1 = what the query asks to find (the excerpt's words), $2 = their tsquery, $3 = the limit.
    expect(calls[0].params.slice(0, 5)).toEqual(["smluvní pokuta", expect.stringContaining("|"), 5, "smluvní pokuta", "nájem"]);
    expect(String(calls[0].params[1])).not.toContain("naj");
    expect(result).toMatchObject({ hits: [], channel: "and" });
    expect(result.terms.join(" ")).not.toContain("naj");
  });

  it("plain words and phrases keep the ordinary search", async () => {
    const { db, calls } = capture();
    await searchDecisions(db as never, { q: '"náhrada újmy" pozůstalým', sources: ["ns"], bm25: true });
    expect(calls[0].text).toContain("t.body &&& $1::text");
    expect(calls[0].text).not.toContain("###");
  });

  it("what it cannot answer is refused with the reason (HTTP 400), so the caller can fall back", async () => {
    const { db, calls } = capture();
    const refusal = (input: Parameters<typeof searchDecisions>[1]) => searchDecisions(db as never, input).then(() => "answered", (error: unknown) => (error instanceof UnsupportedSearch ? error.message : "other error"));
    expect(await refusal({ q: "nájem AND (výpověď", bm25: true })).toContain("the query could not be read: a bracket is not closed");
    expect(await refusal({ q: "nájem OR NOT družstvo", bm25: true })).toContain("NOT cannot stand alone");
    expect(await refusal({ q: "nájem NOT družstvo", bm25: false })).toContain("need the BM25 index");
    expect(await refusal({ q: "nájem NOT družstvo", bm25: true, in: "vyrok" })).toContain("not read in výroky");
    expect(await refusal({ q: "nájem NOT družstvo", bm25: true, caseNumber: "26 Cdo 1/2020" })).toContain("do not combine");
    expect(calls).toHaveLength(0);
  });
});
