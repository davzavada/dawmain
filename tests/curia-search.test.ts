import { afterEach, describe, expect, it, vi } from "vitest";
import { registerCuria } from "@/src/mcp/tools/curia";
import { getCuriaDocument, searchCuria } from "@/src/sources/curia";
import { SourceError } from "@/src/sources/shared/errors";

/**
 * sdeu_search / sdeu_get_document driven through the registered handlers
 * with InfoCuria's and Cellar's HTTP answers mocked — what the TEXT says
 * (the only half a client reads) and how many requests it costs. The caches
 * are module-scope: every test searches its own terms and documents.
 */

type Result = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};
type Handler = (args: Record<string, unknown>) => Promise<Result>;

function handlerOf(name: string): Handler {
  const handlers: Record<string, Handler> = {};
  registerCuria({
    registerTool(toolName: string, _config: unknown, handler: Handler) {
      handlers[toolName] = handler;
    },
  } as never);
  return handlers[name];
}

const search = (args: Record<string, unknown>) =>
  handlerOf("sdeu_search")({ state: "all", doc_type: "any", sort: "relevance", limit: 10, page: 0, language: "en", read_top: 0, ...args });
const getDocument = (args: Record<string, unknown>) =>
  handlerOf("sdeu_get_document")({ doc_type: "judgment", language: "en", page: 1, ...args });

const LONG_HTML = (word: string) => `<html><body><p>${`${word} judgment text paragraph. `.repeat(30)}</p></body></html>`;

interface Doc {
  docTypeCode: string;
  docDate?: string;
  ecli?: string;
  logicDocId?: string;
}

/** One affair (case) with its matching documents, the backend's shape. */
const affair = (caseNumber: string, docs: Doc[], extra: Record<string, unknown> = {}) => ({
  content: { publishedId: caseNumber, affairStateCode: "CLOTPUB", usualNameML: [{ en: `Name of ${caseNumber}` }], ...extra },
  innerHits: { document: { searchHits: docs.map((doc) => ({ document: { docNoPart: caseNumber, ...doc } })) } },
});

/** The four documents a typical closed case carries on the searchTerm route. */
const typicalDocs = (n: number): Doc[] => [
  { docTypeCode: "REQ_COMM", docDate: "2020-03-01", logicDocId: `id_${n}1` },
  { docTypeCode: "ARR_COMM", docDate: "2021-05-01", logicDocId: `id_${n}2` },
  { docTypeCode: "RES", docDate: "2021-03-01", ecli: `ECLI:EU:C:2021:${n}`, logicDocId: `id_${n}3` },
  { docTypeCode: "ARRET", docDate: "2021-03-01", ecli: `ECLI:EU:C:2021:${n}`, logicDocId: `id_${n}4` },
];

interface Sent {
  url: string;
  body?: Record<string, unknown>;
  method: string;
}

/** fetch stub; `answer` gets each request, parsed. */
function stub(answer: (sent: Sent) => Response | Promise<Response>): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const call = {
      url: String(url),
      method: init.method ?? "GET",
      body: typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
    };
    sent.push(call);
    return answer(call);
  });
  return sent;
}

const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
const pagination = (sent: Sent) => sent.body?.pagination as { pageNumber: number; pageSize: number; from: number; to: number };

/** Upstream that pages `cases` cases (C-1/20…) by pageNumber/pageSize. */
function affairsUpstream(cases: number, docsOf: (n: number) => Doc[] = typicalDocs) {
  return (sent: Sent) => {
    const { pageNumber, pageSize } = pagination(sent);
    const hits = [];
    for (let n = pageNumber * pageSize + 1; n <= Math.min(cases, (pageNumber + 1) * pageSize); n++) {
      hits.push(affair(`C-${n}/20`, docsOf(n)));
    }
    return json({ totalHits: cases, searchHits: hits });
  };
}

const numberedCases = (text: string) => [...text.matchAll(/^\d+\. (C-\d+\/20)/gm)].map((m) => m[1]);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("sdeu_search pages by case", () => {
  it("shows every case of the upstream page — no case is skipped between pages", async () => {
    const sent = stub(affairsUpstream(9));
    const page0 = await search({ query: "paging-cases", limit: 3, page: 0 });
    const page1 = await search({ query: "paging-cases", limit: 3, page: 1 });
    expect(numberedCases(page0.content[0].text)).toEqual(["C-1/20", "C-2/20", "C-3/20"]);
    expect(numberedCases(page1.content[0].text)).toEqual(["C-4/20", "C-5/20", "C-6/20"]);
    expect(page1.content[0].text).toMatch(/^4\. C-4\/20/m);
    expect(page0.content[0].text).toContain("9 matching cases, cases 1–3:");
    expect(page0.content[0].text).toContain("More cases: page 1.");
    expect(page0.structuredContent?.has_more).toBe(true);
    expect(sent.map(pagination).map((p) => p.pageSize)).toEqual([3, 3]);
  });

  it("lists the decision first, with both ids and its citable link", async () => {
    stub(affairsUpstream(1));
    const { content } = await search({ query: "decision-first", limit: 1 });
    const text = content[0].text;
    const lines = text.split("\n");
    const first = lines.findIndex((line) => line.startsWith("1. C-1/20"));
    expect(lines[first + 1]).toMatch(/^ {3}- judgment \[ARRET\] 2021-03-01 · ecli: ECLI:EU:C:2021:1 · logic_doc_id: id_14 · https:\/\/curia/);
    // The summary shares the judgment's ECLI and still has its own line.
    expect(text).toContain("summary [RES]");
    expect(text).toContain("OJ notice [ARR_COMM] 2021-05-01 · logic_doc_id: id_12");
    expect(text).toContain("not a decision date");
  });

  it("lists all documents of a single case — the AG opinion is not cut off at limit", async () => {
    const docs: Doc[] = [
      { docTypeCode: "ARRET", ecli: "ECLI:EU:C:2020:559", logicDocId: "id_228677" },
      { docTypeCode: "ARR_COMM", logicDocId: "id_230683" },
      { docTypeCode: "RES", ecli: "ECLI:EU:C:2020:559", logicDocId: "id_228678" },
      { docTypeCode: "DDP_COMM", logicDocId: "id_204046" },
      { docTypeCode: "CONCL", ecli: "ECLI:EU:C:2019:1145", logicDocId: "id_221826" },
    ];
    stub(() => json({ totalHits: 1, searchHits: [affair("C-311/18", docs)] }));
    const result = await search({ case_number: "C-311/18", limit: 2 });
    const text = result.content[0].text;
    for (const id of ["id_228677", "id_230683", "id_228678", "id_204046", "id_221826"]) expect(text).toContain(id);
    expect(text).toContain("AG opinion [CONCL]");
    expect(result.structuredContent?.count).toBe(5);
    expect(result.structuredContent?.has_more).toBe(false);
  });

  it("names a case's further documents with the call that lists them all", async () => {
    stub(affairsUpstream(2));
    const { content } = await search({ query: "more-docs", limit: 2 });
    expect(content[0].text).toContain('+1 more (ARR_COMM) — all: sdeu_search {case_number: "C-1/20"}');
  });

  it("says the date sort is by case lodging date", async () => {
    stub(affairsUpstream(1));
    const { content } = await search({ query: "sorted-lodging", sort: "date" });
    expect(content[0].text).toContain("sorted by case lodging date");
  });
});

describe("sdeu_search with several variants", () => {
  it("reads each variant's prefix in ONE request, whatever the page", async () => {
    const sent = stub(affairsUpstream(60));
    await search({ queries: ["alpha-prefix", "beta-prefix", "gamma-prefix"], limit: 5, page: 9 });
    expect(sent).toHaveLength(3);
    for (const call of sent) expect(pagination(call)).toEqual({ pageNumber: 0, pageSize: 50, from: 1, to: 50 });
  });

  it("refuses to page merged variants past the cap, pointing to a single query", async () => {
    const sent = stub(affairsUpstream(500));
    const result = await search({ queries: ["alpha-cap", "beta-cap"], limit: 20, page: 5 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("single query");
    expect(sent).toHaveLength(0);
  });

  it("pages merged cases contiguously, one entry per case, and keeps a summary sharing the judgment's ECLI", async () => {
    // Variant A finds C-1..C-6, variant B finds C-4..C-9: shared cases merge.
    stub((sent) => {
      const query = ((sent.body?.searchTerm as string) ?? "").startsWith("alpha") ? "a" : "b";
      const numbers = query === "a" ? [1, 2, 3, 4, 5, 6] : [4, 5, 6, 7, 8, 9];
      const { pageSize } = pagination(sent);
      const docsOf = (n: number): Doc[] =>
        query === "a"
          ? [{ docTypeCode: "ARRET", ecli: `ECLI:EU:C:2021:${n}`, logicDocId: `id_${n}4` }]
          : [{ docTypeCode: "RES", ecli: `ECLI:EU:C:2021:${n}`, logicDocId: `id_${n}3` }];
      return json({ totalHits: 6, searchHits: numbers.slice(0, pageSize).map((n) => affair(`C-${n}/20`, docsOf(n))) });
    });
    const page0 = await search({ queries: ["alpha-merge", "beta-merge"], limit: 3, page: 0 });
    const page1 = await search({ queries: ["alpha-merge", "beta-merge"], limit: 3, page: 1 });
    const page2 = await search({ queries: ["alpha-merge", "beta-merge"], limit: 3, page: 2 });
    const all = [page0, page1, page2].flatMap((r) => numberedCases(r.content[0].text));
    expect(new Set(all).size).toBe(all.length);
    expect(all.sort()).toEqual(["C-1/20", "C-2/20", "C-3/20", "C-4/20", "C-5/20", "C-6/20", "C-7/20", "C-8/20", "C-9/20"]);
  });

  it("merges a case found by two variants into one entry, keeping a summary that shares the judgment's ECLI", async () => {
    stub((sent) => {
      const doc: Doc = ((sent.body?.searchTerm as string) ?? "").startsWith("alpha")
        ? { docTypeCode: "ARRET", ecli: "ECLI:EU:C:2021:4", logicDocId: "id_44" }
        : { docTypeCode: "RES", ecli: "ECLI:EU:C:2021:4", logicDocId: "id_43" };
      return json({ totalHits: 1, searchHits: [affair("C-4/20", [doc])] });
    });
    const { content } = await search({ queries: ["alpha-both", "beta-both"], limit: 3 });
    expect(numberedCases(content[0].text)).toEqual(["C-4/20"]);
    expect(content[0].text).toMatch(/judgment \[ARRET\][\s\S]*summary \[RES\]/);
  });
});

describe("sdeu_search criteria and empty pages", () => {
  it("sends an ECLI through the advanced eCli criterion, not the ignored top-level key", async () => {
    const sent = stub(() => json({ totalHits: 1, searchHits: [affair("C-311/18", [{ docTypeCode: "ARRET", ecli: "ECLI:EU:C:2020:559" }])] }));
    await search({ ecli: "ECLI:EU:C:2020:559" });
    expect(sent[0].body?.ecli).toBe("");
    expect(sent[0].body?.advancedFiltersValue).toContainEqual({
      field: "eCli",
      values: ["ECLI:EU:C:2020:559"],
      valuesWithFullHierarchy: ["ECLI:EU:C:2020:559"],
    });
  });

  it("says a page past the end is past the end", async () => {
    stub(() => json({ totalHits: 6685, searchHits: [] }));
    const { content } = await search({ query: "past-the-end", page: 700, limit: 10 });
    expect(content[0].text).toContain("Page 700 is past the end — 6685 matching cases, pages 0–668 at limit 10.");
  });

  it("says the filter removed the page's documents instead of blaming the query", async () => {
    stub(() =>
      json({ totalHits: 5, searchHits: [affair("C-9/24", [{ docTypeCode: "ARRET" }], { affairStateCode: "ENCOURS" })] }),
    );
    const { content } = await search({ query: "guarded-away", state: "closed", limit: 1 });
    expect(content[0].text).toContain("All 1 documents on this page fall outside the doc_type/state/date filter — try page 1");
    expect(content[0].text).not.toContain("no document scored");
  });

  it("with variants, blames the filter — not the paging — when it emptied every case read", async () => {
    stub(() =>
      json({ totalHits: 2, searchHits: [affair("C-8/24", [{ docTypeCode: "ARRET" }], { affairStateCode: "ENCOURS" })] }),
    );
    const { content } = await search({ queries: ["alpha-guarded", "beta-guarded"], state: "closed", limit: 5 });
    expect(content[0].text).not.toContain("past the end");
    expect(content[0].text).toContain("fall outside the doc_type/state/date filter; there are no further pages");
  });

  it("with variants, says a page past the merged cases is past the end", async () => {
    stub(affairsUpstream(4));
    const { content } = await search({ queries: ["alpha-end", "beta-end"], limit: 2, page: 3 });
    expect(content[0].text).toContain("Page 3 is past the end — 4 cases merged from the variants, pages 0–1 at limit 2.");
  });

  it("previews the case's judgment, not the OJ notice listed first", async () => {
    const sent = stub((call) => {
      if (call.url.includes("elastic-connector")) return json({ totalHits: 1, searchHits: [affair("C-1/20", typicalDocs(77))] });
      return new Response(LONG_HTML("preview"), { status: 200 });
    });
    const result = await search({ query: "preview", read_top: 1 });
    const textCalls = sent.filter((call) => !call.url.includes("elastic-connector"));
    expect(textCalls[0].url).toContain("/ecli/ECLI%3AEU%3AC%3A2021%3A77");
    expect(result.content[0].text).toContain("PREVIEW C-1/20");
  });

  it("previews by logic_doc_id when Cellar has no text under the ECLI", async () => {
    const sent = stub((call) => {
      if (call.url.includes("elastic-connector")) {
        return json({ totalHits: 1, searchHits: [affair("C-2/20", [{ docTypeCode: "ARRET", ecli: "ECLI:EU:C:2099:2", logicDocId: "id_990002" }])] });
      }
      if (call.url.includes("publications.europa.eu")) return new Response("", { status: 404 });
      return new Response(LONG_HTML("blobpreview"), { status: 200 });
    });
    const result = await search({ query: "blobpreview", read_top: 1 });
    expect(sent.some((call) => call.url.includes("/blob/download-file/990002/EN/html"))).toBe(true);
    expect(result.content[0].text).toContain("PREVIEW C-2/20");
  });
});

describe("searchCuria failures", () => {
  it("reports a non-JSON 200 as PARSE_DRIFT, not as silence", async () => {
    stub(() => new Response("<html>blocked</html>", { status: 200 }));
    const error = await searchCuria({ query: "non-json-200" }, 0, 10).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SourceError);
    expect((error as SourceError).kind).toBe("PARSE_DRIFT");
    expect((error as SourceError).message).toContain("<html>blocked</html>");
  });

  it("does not tell the model to wait out a rejected request shape", async () => {
    stub(() => new Response("bad", { status: 400 }));
    const rejected = (await searchCuria({ query: "shape-400" }, 0, 10).catch((e: unknown) => e)) as SourceError;
    expect(rejected.hint).not.toContain("Try again");
    expect(rejected.hint).toContain("dawmain_probe_sources");
    stub(() => new Response("no", { status: 403 }));
    const refused = (await searchCuria({ query: "waf-403" }, 0, 10).catch((e: unknown) => e)) as SourceError;
    expect(refused.hint).toContain("Try again");
  });
});

describe("getCuriaDocument", () => {
  it("caches blob texts — a second read of the same document costs nothing", async () => {
    const sent = stub(() => new Response(LONG_HTML("blobcache"), { status: 200 }));
    const first = await getCuriaDocument({ logicDocId: "id_999001" });
    const second = await getCuriaDocument({ logicDocId: "id_999001" });
    expect(second.text).toBe(first.text);
    expect(first.via).toBe("infocuria-blob");
    expect(sent).toHaveLength(1);
    await getCuriaDocument({ logicDocId: "id_999001", language: "cs" });
    expect(sent).toHaveLength(2);
    expect(sent[1].url).toContain("/999001/CS/html");
  });

  it("does not cache a blob miss", async () => {
    let calls = 0;
    stub(() => (++calls === 1 ? new Response("", { status: 404 }) : new Response(LONG_HTML("blobmiss"), { status: 200 })));
    await expect(getCuriaDocument({ logicDocId: "id_999003" })).rejects.toMatchObject({ kind: "NOT_FOUND" });
    await expect(getCuriaDocument({ logicDocId: "id_999003" })).resolves.toMatchObject({ via: "infocuria-blob" });
  });

  it("falls back to the blob when Cellar is down, without trying the next Cellar identifier", async () => {
    const sent = stub((call) =>
      call.url.includes("publications.europa.eu")
        ? new Response("", { status: 503 })
        : new Response(LONG_HTML("outage"), { status: 200 }),
    );
    const document = await getCuriaDocument({ celex: "62099CJ0001", ecli: "ECLI:EU:C:2099:1", logicDocId: "id_999002" });
    expect(document.via).toBe("infocuria-blob");
    expect(sent.some((call) => call.url.includes("/ecli/"))).toBe(false);
  }, 15_000);

  it("falls back to the English blob when the requested language has none, and says so", async () => {
    const sent = stub((call) =>
      call.url.includes("/CS/html") ? new Response("", { status: 404 }) : new Response(LONG_HTML("blobfallback"), { status: 200 }),
    );
    const document = await getCuriaDocument({ logicDocId: "id_999005", language: "cs" });
    expect(sent.map((call) => call.url.split("/").slice(-2).join("/"))).toEqual(["CS/html", "EN/html"]);
    expect(document).toMatchObject({ via: "infocuria-blob", language: "en", fallback: true });
  });

  it("does not refuse a logic_doc_id-only read over a language Cellar does not know", async () => {
    const sent = stub(() => new Response(LONG_HTML("blobunknown"), { status: 200 }));
    const document = await getCuriaDocument({ logicDocId: "id_999006", language: "xx" });
    expect(sent[0].url).toContain("/999006/EN/html");
    expect(document).toMatchObject({ language: "en", fallback: true });
    await expect(getCuriaDocument({ ecli: "ECLI:EU:C:2099:6", language: "xx" })).rejects.toMatchObject({
      kind: "INPUT_INVALID",
    });
  });

  it("reports the Cellar outage, not NOT_FOUND, when the blob has nothing either", async () => {
    stub((call) => new Response("", { status: call.url.includes("publications.europa.eu") ? 503 : 404 }));
    const error = (await getCuriaDocument({ ecli: "ECLI:EU:C:2099:4", logicDocId: "id_999004" }).catch((e: unknown) => e)) as SourceError;
    expect(error.kind).toBe("UPSTREAM_ERROR");
  }, 15_000);
});

describe("sdeu_get_document identifiers", () => {
  it("reads an appeal by the case number sdeu_search prints", async () => {
    const sent = stub(() => new Response(LONG_HTML("appeal"), { status: 200 }));
    const result = await getDocument({ case_number: "C-465/20 P" });
    expect(result.isError).toBeFalsy();
    expect(sent[0].url).toContain("/celex/62020CJ0465");
  });

  it("names the unmappable case number and points to the ecli", async () => {
    const sent = stub(() => new Response("", { status: 404 }));
    const result = await getDocument({ case_number: "T-18/10 RENV" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("case_number 'T-18/10 RENV' cannot be mapped to a CELEX");
    expect(result.content[0].text).toContain("ecli");
    expect(sent).toHaveLength(0);
  });

  it("lets an explicit ecli or logic_doc_id win over the CELEX derived from case_number", async () => {
    const sent = stub(() => new Response(LONG_HTML("explicit"), { status: 200 }));
    await getDocument({ ecli: "ECLI:EU:C:2019:1145", case_number: "C-311/18" });
    expect(sent[0].url).toContain("/ecli/ECLI%3AEU%3AC%3A2019%3A1145");
    expect(sent.some((call) => call.url.includes("/celex/"))).toBe(false);
    await getDocument({ logic_doc_id: "id_204046", case_number: "C-311/18" });
    expect(sent.at(-1)?.url).toContain("/blob/download-file/204046/");
    await getDocument({ case_number: "C-311/18", doc_type: "opinion" });
    expect(sent.at(-1)?.url).toContain("/celex/62018CC0311");
  });

  it("says when the text served is the English fallback", async () => {
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      const lang = (init.headers as Record<string, string>)["accept-language"];
      return lang === "ces" ? new Response("", { status: 404 }) : new Response(LONG_HTML("english"), { status: 200 });
    });
    const result = await getDocument({ celex: "62016CJ0001", language: "cs" });
    expect(result.content[0].text).toContain("this is the English version");
    expect(result.structuredContent?.language).toBe("en");
  });
});
