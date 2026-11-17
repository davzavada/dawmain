import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  LP_DOC_KINDS,
  buildLpFilterRequest,
  dispositionName,
  getLpDocumentText,
  parseLpDetail,
  parseLpDocuments,
  parseLpHistory,
  parseLpNumber,
  parseLpSearch,
} from "@/src/sources/slovlex-lp";
import { setDocumentConverters, type DocumentConverters } from "@/src/sources/shared/documents";
import { registerSkLp, skLpProcessText, skLpSearchText } from "@/src/mcp/tools/sk-lp";

/**
 * Fixtures in tests/fixtures/slovlex/ are LIVE captures (17. 11. 2026):
 * the eLegislatíva filter with an empty body and with hladanyVyraz, the
 * detail, /historia and the last stage's sprievodne-dokumenty of
 * LP/2025/300 (→ 325/2025 Z. z.), and one downloaded file
 * (02_predkladacia.docx).
 */

const dir = path.join(__dirname, "fixtures", "slovlex");
const json = (name: string) => JSON.parse(readFileSync(path.join(dir, name), "utf8")) as unknown;
const FILTER_EMPTY = json("lp-filter-empty.json");
const FILTER_TEXT = json("lp-filter-text.json");
const DETAIL = json("lp-detail-2025-300.json");
const HISTORIA = json("lp-historia-2025-300.json");
const DOKUMENTY = json("lp-dokumenty-2025-300.json");
const DOCX = readFileSync(path.join(dir, "lp-doc-predkladacia.docx"));

const PROCESS_UUID = "4a09876f-79e3-4751-8480-a79d553f749d";
const LAST_STAGE = "078ccd8f-3821-4df1-a114-7e3b7cff30b2";
const VSEOBECNA = "16889e47-0109-4b0f-a489-51ea2e889144";
const OSOBITNA = "4e43f704-7b3d-4461-a6d5-63978badd570";
const PREDKLADACIA = "00fdd449-ffe3-43f9-8e13-64d990c8c884";

type Result = { content: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<Result>;
const tools: Record<string, Handler> = {};
const kind = (result: Result) => (result.structuredContent?.error as { kind?: string } | undefined)?.kind;
registerSkLp({ registerTool: (name: string, _config: unknown, handler: Handler) => void (tools[name] = handler) } as never);

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fileResponse = (bytes: Uint8Array<ArrayBuffer>, name: string) =>
  new Response(bytes, { status: 200, headers: { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${name}"` } });

interface Call {
  url: string;
  method: string;
  body?: unknown;
}

/** A fetch stub that routes the gateway's addresses to the captures; `extra` answers first. */
function stubGateway(extra?: (call: Call) => Response | undefined): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const call: Call = { url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      const answer = extra?.(call);
      if (answer) return answer;
      if (url.includes("/legislativne-materialy/filter")) return jsonResponse(FILTER_TEXT);
      if (url.endsWith("/legislativne-materialy/LP/2025/300")) return jsonResponse(DETAIL);
      if (url.endsWith(`/legislativne-materialy/${PROCESS_UUID}/historia`)) return jsonResponse(HISTORIA);
      if (url.includes(`/legislativne-materialy/${PROCESS_UUID}/sprievodne-dokumenty`)) return jsonResponse(DOKUMENTY);
      const download = /sprievodne-dokumenty\/([0-9a-f-]+)\/download$/.exec(url);
      if (download) return fileResponse(new Uint8Array(DOCX), `${download[1]}.docx`);
      return new Response("not found", { status: 404 });
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  setDocumentConverters();
});

describe("eLegislatíva parsers", () => {
  it("parses the filter answers", () => {
    const empty = parseLpSearch(FILTER_EMPTY);
    expect(empty.total).toBe(12274);
    expect(empty.hits).toHaveLength(5);
    expect(empty.hits[0]).toMatchObject({
      lp: "LP/2026/625",
      prefix: "LP",
      year: 2026,
      number: 625,
      uuid: "be203db3-10a3-4ca9-845d-be8911833d72",
      type: "Zákon",
      stage: "Rokovanie Národnej rady SR",
      stageCode: "ROKOVANIE_NRSR",
      stageFrom: "2026-11-17",
      url: "https://www.slov-lex.sk/elegislativa/legislativne-procesy/SK/LP/2026/625",
    });
    expect(empty.hits[3]).toMatchObject({ lp: "LPEU/2026/583", prefix: "LPEU", type: "Akt EÚ" });
    const text = parseLpSearch(FILTER_TEXT);
    expect(text.total).toBe(2439);
    expect(text.hits.map((h) => h.lp)).toEqual(["LP/2026/332", "LP/2026/559", "LP/2026/357", "LP/2026/355", "LP/2026/461"]);
    // Double spaces in titles collapse.
    expect(text.hits[3].title).not.toMatch(/ {2}/);
    expect(() => parseLpSearch({ foo: 1 })).toThrow(/legMaterialList/);
  });

  it("builds the filter request with only the given criteria", () => {
    expect(buildLpFilterRequest({}, 1, 10)).toEqual({
      url: "https://api-gateway.slov-lex.sk/internal/elegislativa/legislativne-materialy/filter?page=1&size=10",
      body: {},
    });
    const full = buildLpFilterRequest({ query: " školstvo ", number: "LP/2025/300", title: "zákon", stage: "MPK", year: 2025, typeCode: "Zakon" }, 3, 25);
    expect(full.url).toMatch(/\?page=3&size=25$/);
    expect(full.body).toEqual({ hladanyVyraz: "školstvo", cisloLegislativnehoMaterialu: "LP/2025/300", nazov: "zákon", stadium: "MPK", rocnik: 2025, typKod: "Zakon" });
    expect(buildLpFilterRequest({ query: "  " }, 1, 5).body).toEqual({});
  });

  it("reads process numbers", () => {
    expect(parseLpNumber("LP/2025/300")).toEqual({ prefix: "LP", year: 2025, number: 300 });
    expect(parseLpNumber("lpeu/2026/583")).toEqual({ prefix: "LPEU", year: 2026, number: 583 });
    expect(parseLpNumber("2025/300")).toEqual({ prefix: null, year: 2025, number: 300 });
    expect(parseLpNumber("300/2025")).toBeNull();
    expect(parseLpNumber("zákon")).toBeNull();
  });

  it("parses the detail", () => {
    const detail = parseLpDetail(DETAIL);
    expect(detail).toMatchObject({
      uuid: PROCESS_UUID,
      lp: "LP/2025/300",
      year: 2025,
      number: 300,
      type: "Zákon",
      typeCode: "Zakon",
      stage: "Vyhlásené v Zbierke zákonov SR",
      stageCode: "VYHLASENE_V_ZBIERKE",
      lastChange: "2025-11-24",
      ministryNumber: "spis č. 2025/10902-A1810",
      submitter: "Tomáš Drucker",
      institution: "Ministerstvo školstva, výskumu, vývoja a mládeže Slovenskej republiky",
      mpkFrom: "2025-06-18",
      mpkTo: "2025-07-11",
      nrsrResult: "Materiál schválený",
      url: "https://www.slov-lex.sk/elegislativa/legislativne-procesy/SK/LP/2025/300",
    });
    expect(detail.areas).toEqual(["Predškolská výchova", "Stredné školstvo", "Základné školstvo"]);
    expect(detail.mainAmended).toMatchObject({ citation: "138/2019 Z. z.", iri: "/SK/ZZ/2019/138", year: 2019, number: 138 });
    expect(detail.amended.map((a) => a.citation)).toEqual(["182/2023 Z. z.", "292/2024 Z. z."]);
    expect(detail.publishedAs).toEqual([
      expect.objectContaining({ citation: "325/2025 Z. z.", iri: "/SK/ZZ/2025/325", year: 2025, number: 325 }),
    ]);
  });

  it("parses the stage history", () => {
    const stages = parseLpHistory(HISTORIA);
    expect(stages.length).toBeGreaterThanOrEqual(10);
    expect(stages[0]).toEqual({ uuid: "ad4bf4eb-4673-44a4-93ff-2f459b077606", code: "PRIPRAVA_MATERIALU", name: "Príprava materiálu", from: "2025-06-10", to: "2025-06-18", owner: "MŠVVaMSR" });
    expect(stages[1]).toMatchObject({ code: "MPK", from: "2025-06-18", to: "2025-07-11" });
    expect(stages[1].owner).toBeUndefined();
    expect(stages.some((s) => s.uuid === LAST_STAGE && s.code === "PRED_VYHLASENIM_V_ZBIERKE")).toBe(true);
  });

  it("parses the files of the last stage: 19, with their kinds", () => {
    const docs = parseLpDocuments(DOKUMENTY);
    expect(docs).toHaveLength(19);
    expect(docs[0]).toEqual({ documentId: "90bb458d-0115-49c2-b6ab-187ab7f0fe74", name: "00_obal.docx", kind: "Obal materiálu", kindCode: "ObalMaterialu", size: 30300 });
    const reasons = docs.filter((d) => d.kindCode === "DovodovaSprava").map((d) => d.name);
    expect(reasons).toEqual(["04_vseobecna.docx", "05_osobitna.docx"]);
    const kinds = new Set(docs.map((d) => d.kindCode));
    for (const kind of ["VlastnyMaterial", "PredkladaciaSprava", "DolozkaVplyvov", "TabulkaZhody", "SchvaleneZnenieZakonaVNRSR", "VyhodnotenieMedzirezortnehoPripomienkovehoKonania"]) {
      expect(kinds.has(kind)).toBe(true);
    }
    // Every captured kind is in the known vocabulary, with the portal's name.
    for (const doc of docs) expect(LP_DOC_KINDS[doc.kindCode]).toBe(doc.kind);
    expect(() => parseLpDocuments({})).toThrow(/not an array/);
  });

  it("reads the file name from Content-Disposition", () => {
    expect(dispositionName('attachment; filename="04_vseobecna.docx"')).toBe("04_vseobecna.docx");
    expect(dispositionName("attachment; filename*=UTF-8''07_dolo%C5%BEka.docx")).toBe("07_doložka.docx");
    expect(dispositionName(null)).toBeUndefined();
  });
});

describe("answer texts", () => {
  it("renders the process: timeline, the act it became, file calls", () => {
    const stages = parseLpHistory(HISTORIA);
    const lastIndex = stages.findIndex((s) => s.uuid === LAST_STAGE) + 1;
    const text = skLpProcessText({ detail: parseLpDetail(DETAIL), stages, documentsStage: lastIndex, documents: parseLpDocuments(DOKUMENTY) });
    expect(text).toMatch(/^LP\/2025\/300 — Návrh zákona, ktorým sa mení a dopĺňa zákon č\. 138\/2019/);
    expect(text).toContain("Predkladateľ: Tomáš Drucker");
    expect(text).toContain("Rezortné číslo: spis č. 2025/10902-A1810");
    expect(text).toContain("MPK: 2025-06-18 – 2025-07-11 · Výsledok NR SR: Materiál schválený");
    expect(text).toContain("Novelizuje: 138/2019 Z. z. (hlavný)");
    expect(text).toContain("Vyhlásené ako 325/2025 Z. z. → sk_predpis_get_text {year: 2025, number: 325}");
    expect(text).toContain("1. 2025-06-10 – 2025-06-18 Príprava materiálu (MŠVVaMSR)");
    expect(text).toContain("2. 2025-06-18 – 2025-07-11 Pripomienkové konanie");
    expect(text).toContain(`Files of stage ${lastIndex} (Pred vyhlásením v Zbierke zákonov SR, 2025-11-24) — 19:`);
    expect(text).toContain(`5. [Dôvodová správa] 04_vseobecna.docx (25 kB) → sk_lp_get_text {document_id: "${VSEOBECNA}"}`);
    expect(text).toContain("stage: 1–");
  });

  it("renders search hits, the next page and a page past the end", () => {
    const { hits, total } = parseLpSearch(FILTER_EMPTY);
    const text = skLpSearchText(hits, total, { stage: "ROKOVANIE_NRSR", limit: 5, page: 1 });
    expect(text).toMatch(/^12274 legislative processes with stage Rokovanie Národnej rady SR — hits 1–5 \(page 1\)/);
    expect(text).toContain("1. LP/2026/625 — Návrh zákona");
    expect(text).toContain("[Zákon] · Rokovanie Národnej rady SR od 2026-11-17");
    expect(text).toContain("LPEU/2026/583");
    expect(text).toContain("EU act consultation");
    expect(text).toContain("More: page: 2 (same arguments).");
    expect(skLpSearchText([], 12, { query: "x", limit: 10, page: 3 })).toBe("No more processes: the 12 matches end before page 3 (pages 1–2 hold them all).");
    expect(skLpSearchText([], 0, { query: "xyz", limit: 10, page: 1 })).toMatch(/^No legislative process with text "xyz"\./);
  });
});

describe("sk_lp_search", () => {
  it("searches the full text and maps the page", async () => {
    const calls = stubGateway();
    const result = await tools.sk_lp_search({ query: "zákon", stage: "MPK", limit: 5, page: 2 });
    expect(result.isError).toBeUndefined();
    expect(calls[0]).toMatchObject({ method: "POST", body: { hladanyVyraz: "zákon", stadium: "MPK" } });
    expect(calls[0].url).toMatch(/filter\?page=2&size=5$/);
    expect(result.structuredContent).toMatchObject({ total: 2439, count: 5, page: 2, has_more: true });
    const items = result.structuredContent!.items as Array<Record<string, unknown>>;
    expect(items[0]).toEqual({
      lp: "LP/2026/332",
      year: 2026,
      number: 332,
      uuid: "0d1116ea-ade6-4e73-9d48-778635c9d490",
      type: "Zákon",
      title: expect.stringContaining("81/2025"),
      stage: "Rokovanie Národnej rady SR",
      stage_from: "2026-11-17",
      url: "https://www.slov-lex.sk/elegislativa/legislativne-procesy/SK/LP/2026/332",
    });
    expect(result.content[0].text).toContain("6. LP/2026/332");
  });

  it("looks a number up exactly", async () => {
    const calls = stubGateway();
    await tools.sk_lp_search({ number: "lp/2025/300", limit: 10, page: 1 });
    expect(calls[0].body).toEqual({ cisloLegislativnehoMaterialu: "LP/2025/300" });
    await tools.sk_lp_search({ number: "2025/300", limit: 10, page: 1 });
    expect(calls[1].body).toEqual({ cisloLegislativnehoMaterialu: "2025/300" });
    const bad = await tools.sk_lp_search({ number: "300/2025", limit: 10, page: 1 });
    expect(bad.isError).toBe(true);
    expect(kind(bad)).toBe("INPUT_INVALID");
  });

  it("finds the process an act was published from, and only that one", async () => {
    const title = "Zákon, ktorým sa mení a dopĺňa zákon č. 138/2019 Z. z. o pedagogických zamestnancoch";
    const other = { ...(FILTER_TEXT as { legMaterialList: unknown[] }).legMaterialList[0] as object };
    const calls = stubGateway((call) => {
      if (call.url.includes("/vyhladavanie/predpisZbierky/rozsirene")) {
        return jsonResponse({ numFound: 1, start: 0, docs: [{ iri: "/SK/ZZ/2025/325/20290901", cislo: "325/2025 Z. z.", nazov: title }] });
      }
      if (call.url.includes("/filter")) {
        return jsonResponse({
          totalElements: 2,
          legMaterialList: [other, { uuid: PROCESS_UUID, typNazov: "Zákon", cisloLegislativnehoMaterialu: "LP/2025/300", nazov: `Návrh z${title.slice(1)}`, stadium: { hodnota: "VYHLASENE_V_ZBIERKE", nazov: "Vyhlásené v Zbierke zákonov SR" }, zaciatokStadia: "2025-11-24" }],
        });
      }
      if (call.url.endsWith("/LP/2026/332")) return jsonResponse({ ...(DETAIL as object), uuid: "x", cisloLegislativnehoMaterialu: "LP/2026/332", vyhlasenyPodCislomList: [] });
      return undefined;
    });
    const result = await tools.sk_lp_search({ act: "325/2025 Z. z.", limit: 10, page: 1 });
    expect(result.isError).toBeUndefined();
    expect(new URL(calls[0].url).searchParams.get("cislo")).toBe("325/2025");
    expect(calls.find((c) => c.url.includes("/filter"))!.body).toEqual({ nazov: title });
    expect(result.structuredContent).toMatchObject({ total: 1, count: 1, has_more: false });
    expect((result.structuredContent!.items as Array<{ lp: string }>).map((i) => i.lp)).toEqual(["LP/2025/300"]);
    expect(result.content[0].text).toContain("published as act 325/2025 Z. z.");
  });

  it("says why an act has no process", async () => {
    stubGateway((call) => {
      if (call.url.includes("/vyhladavanie/predpisZbierky/rozsirene")) return jsonResponse({ numFound: 0, start: 0, docs: [] });
      return undefined;
    });
    const result = await tools.sk_lp_search({ act: "9999/2024", limit: 10, page: 1 });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ total: 0, count: 0 });
    expect(result.content[0].text).toContain("knows no act 9999/2024");
  });

  it("refuses a call without criteria", async () => {
    const result = await tools.sk_lp_search({ limit: 10, page: 1 });
    expect(result.isError).toBe(true);
    expect(kind(result)).toBe("INPUT_INVALID");
  });

  it("reports Spring's 401 as drift, not as an outage", async () => {
    stubGateway((call) => (call.url.includes("/filter") ? new Response("", { status: 401, headers: { "www-authenticate": "Basic" } }) : undefined));
    const result = await tools.sk_lp_search({ query: "drift-401", limit: 10, page: 1 });
    expect(result.isError).toBe(true);
    expect(kind(result)).toBe("PARSE_DRIFT");
  });
});

describe("sk_lp_get_process", () => {
  it("chains detail → historia → the last stage's files", async () => {
    const calls = stubGateway();
    const result = await tools.sk_lp_get_process({ year: 2025, number: 300 });
    expect(result.isError).toBeUndefined();
    const sc = result.structuredContent!;
    expect(sc).toMatchObject({ lp: "LP/2025/300", uuid: PROCESS_UUID, stage: "Vyhlásené v Zbierke zákonov SR", published_as: [{ citation: "325/2025 Z. z.", year: 2025, number: 325 }] });
    expect((sc.documents as unknown[]).length).toBe(19);
    expect((sc.documents as Array<Record<string, unknown>>)[4]).toEqual({ document_id: VSEOBECNA, name: "04_vseobecna.docx", kind: "Dôvodová správa", kind_code: "DovodovaSprava", size: 25226 });
    const stages = sc.stages as Array<{ index: number; code: string }>;
    expect(sc.documents_stage).toBe(stages.find((s) => s.code === "PRED_VYHLASENIM_V_ZBIERKE")!.index);
    const filesCall = calls.find((c) => c.url.includes("sprievodne-dokumenty?"));
    expect(filesCall!.url).toContain(`stadiumUuid=${LAST_STAGE}`);
    expect(result.content[0].text).toContain("Vyhlásené ako 325/2025 Z. z.");
  });

  it("lists an earlier stage's files and refuses a stage out of range", async () => {
    const calls = stubGateway();
    const result = await tools.sk_lp_get_process({ year: 2025, number: 300, stage: 2 });
    expect(result.structuredContent!.documents_stage).toBe(2);
    expect(calls.some((c) => c.url.includes("stadiumUuid=23b70e69-7b46-43dd-b7dd-8aba88759099"))).toBe(true);
    const bad = await tools.sk_lp_get_process({ year: 2025, number: 300, stage: 99 });
    expect(bad.isError).toBe(true);
    expect(kind(bad)).toBe("INPUT_INVALID");
  });

  it("answers NOT_FOUND for an unknown process", async () => {
    stubGateway((call) => (call.url.endsWith("/LP/2025/999999") ? jsonResponse("Material with cislo LP/2025/999999 was not found.", 404) : undefined));
    const result = await tools.sk_lp_get_process({ year: 2025, number: 999999 });
    expect(result.isError).toBe(true);
    expect(kind(result)).toBe("NOT_FOUND");
    expect(result.content[0].text).toContain("LP/2025/999999");
  });
});

describe("sk_lp_get_text", () => {
  it("reads a DOCX file by document_id through mammoth", async () => {
    const calls = stubGateway();
    const result = await tools.sk_lp_get_text({ document_id: PREDKLADACIA, page: 1 });
    expect(result.isError).toBeUndefined();
    expect(calls[0].url).toBe(`https://api-gateway.slov-lex.sk/external/evidencna-aplikacia/sprievodne-dokumenty/${PREDKLADACIA}/download`);
    expect(result.structuredContent).toMatchObject({ format: "docx", page: 1 });
    const text = result.structuredContent!.text as string;
    expect(text.length).toBeGreaterThan(500);
    expect(text).toMatch(/[Pp]redklad/);
    expect(result.content[0].text.startsWith(`${PREDKLADACIA}.docx — https://`)).toBe(true);
  });

  it("joins the dôvodová správa of a process and lists the other files", async () => {
    const docx = vi.fn(async (bytes: ArrayBuffer) => `text of ${bytes.byteLength} bytes`);
    setDocumentConverters({ docx, pdf: async () => ({ unavailable: "broken" }) });
    const calls = stubGateway((call) => {
      const m = /sprievodne-dokumenty\/([0-9a-f-]+)\/download$/.exec(call.url);
      if (m && m[1] === OSOBITNA) return fileResponse(new Uint8Array([...DOCX, 0]), "05_osobitna.docx");
      return undefined;
    });
    const result = await tools.sk_lp_get_text({ year: 2025, number: 300, page: 1 });
    expect(result.isError).toBeUndefined();
    const downloads = calls.filter((c) => c.url.endsWith("/download")).map((c) => c.url);
    expect(downloads.some((u) => u.includes(VSEOBECNA))).toBe(true);
    expect(downloads.some((u) => u.includes(OSOBITNA))).toBe(true);
    expect(downloads).toHaveLength(2);
    const text = result.content[0].text;
    expect(text).toContain("Dôvodová správa: 04_vseobecna.docx, 05_osobitna.docx");
    expect(text).toContain("=== 04_vseobecna.docx (Dôvodová správa) ===");
    expect(text).toContain("=== 05_osobitna.docx (Dôvodová správa) ===");
    expect(text).toContain("Other files of this stage:");
    expect(text).toContain(`[Predkladacia správa] 02_predkladacia.docx (24 kB) → sk_lp_get_text {document_id: "${PREDKLADACIA}"}`);
    expect(result.structuredContent).toMatchObject({ url: "https://www.slov-lex.sk/elegislativa/legislativne-procesy/SK/LP/2025/300", format: "docx" });
    expect((result.structuredContent!.documents as unknown[]).length).toBe(17);
  });

  it("converts a PDF window with injected converters and says how to go on", async () => {
    const pdf = vi.fn<DocumentConverters["pdf"]>(async (_bytes, range) => ({ text: `⟦s. ${range[0]}⟧ Dôvodová správa`, pages: 150, range, warnings: [] }));
    setDocumentConverters({ pdf, docx: async () => "" });
    const id = "11111111-2222-4333-8444-555555555555";
    stubGateway((call) => (call.url.includes(id) ? fileResponse(new TextEncoder().encode("%PDF-1.7 fake"), "material.pdf") : undefined));
    const result = await tools.sk_lp_get_text({ document_id: id, pdf_pages: "61", page: 1 });
    expect(result.isError).toBeUndefined();
    expect(pdf).toHaveBeenCalledWith(expect.any(ArrayBuffer), [61, 120]);
    expect(result.structuredContent).toMatchObject({ format: "pdf", pdf: { pages: 150, range: [61, 120] } });
    expect(result.content[0].text).toContain("PDF: pages 61–120 of 150 converted.");
    expect(result.content[0].text).toContain('pdf_pages: "121-150"');
  });

  it("caches a converted file", async () => {
    setDocumentConverters({ pdf: async () => ({ unavailable: "broken" }), docx: async () => "cached text" });
    const id = "22222222-2222-4333-8444-555555555555";
    const calls = stubGateway();
    await getLpDocumentText(id);
    await getLpDocumentText(id);
    expect(calls.filter((c) => c.url.includes(id))).toHaveLength(1);
  });

  it("refuses a call without an id", async () => {
    const result = await tools.sk_lp_get_text({ year: 2025, page: 1 });
    expect(result.isError).toBe(true);
    expect(kind(result)).toBe("INPUT_INVALID");
  });

  it("answers NOT_FOUND for an unknown file", async () => {
    stubGateway((call) => (call.url.endsWith("/download") ? new Response("", { status: 404 }) : undefined));
    const result = await tools.sk_lp_get_text({ document_id: "33333333-2222-4333-8444-555555555555", page: 1 });
    expect(result.isError).toBe(true);
    expect(kind(result)).toBe("NOT_FOUND");
  });
});
