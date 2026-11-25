import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** esbirka_get_text through its MCP handler — the text is all the model sees. */

type Handler = (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;

async function getTextTool(): Promise<Handler> {
  const { registerEsbirka } = await import("@/src/mcp/tools/esbirka");
  let handler: Handler | undefined;
  registerEsbirka({
    registerTool(name: string, _config: unknown, callback: Handler) {
      if (name === "esbirka_get_text") handler = callback;
    },
  } as never);
  if (!handler) throw new Error("esbirka_get_text did not register");
  return handler;
}

const DETAIL = {
  nazev: "Zákon občanský zákoník",
  staleUrl: "/sb/2012/89/2026-01-01",
  datumUcinnostiZneniOd: "2026-01-01",
  typZneni: "AKTUALNI",
};
const HISTORY = {
  historie: [
    { datumUcinnostiZneniOd: "2027-01-01", typZneni: "BUDOUCI" },
    { datumUcinnostiZneniOd: "2026-01-01", typZneni: "AKTUALNI" },
  ],
};

function fragmentsOf(labels: string[], odstavce = 1): unknown[] {
  return labels.flatMap((label) => [
    { kodTypuFragmentu: "Paragraf", zkracenaCitace: `§ ${label} zákona č. 89/2012 Sb.`, xhtml: `§ ${label}` },
    ...Array.from({ length: odstavce }, (_, k) => ({
      kodTypuFragmentu: "Odstavec_Dc",
      zkracenaCitace: `§ ${label} odst. ${k + 1} zákona č. 89/2012 Sb.`,
      xhtml: `(${k + 1}) Text ${label}/${k + 1}.`,
    })),
  ]);
}

interface Event {
  kind: "detail" | "historie" | "fragmenty" | "sparql";
  at: "start" | "end";
}

/** Every upstream request, each answered after `delayMs`. */
function serve(options: { delayMs?: number; seznam?: unknown[]; pages?: number; detail?: () => Response; future?: unknown[] } = {}): Event[] {
  const events: Event[] = [];
  vi.stubGlobal("fetch", async (input: string) => {
    const url = decodeURIComponent(String(input));
    const kind: Event["kind"] = url.includes("/sparql?")
      ? "sparql"
      : url.includes("/historie")
        ? "historie"
        : url.includes("/fragmenty")
          ? "fragmenty"
          : "detail";
    events.push({ kind, at: "start" });
    await new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 0));
    events.push({ kind, at: "end" });
    if (kind === "sparql") return new Response("blocked", { status: 403, headers: { "content-type": "text/html" } });
    if (kind === "historie") return new Response(JSON.stringify(HISTORY));
    // The future version, when a test gives it its own wording: its own detail and fragments.
    if (options.future && url.includes("2027-01-01")) {
      if (kind === "fragmenty") return new Response(JSON.stringify({ pocetStranek: 1, seznam: options.future }));
      return new Response(JSON.stringify({ ...DETAIL, staleUrl: "/sb/2012/89/2027-01-01", datumUcinnostiZneniOd: "2027-01-01", typZneni: "BUDOUCI" }));
    }
    if (kind === "fragmenty") {
      return new Response(JSON.stringify({ pocetStranek: options.pages ?? 1, seznam: options.seznam ?? fragmentsOf(["28", "29", "30"]) }));
    }
    return options.detail ? options.detail() : new Response(JSON.stringify(DETAIL));
  });
  return events;
}

const base = { year: 2012, number: 89, collection: "sb", page: 1 };

beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("esbirka_get_text section read", () => {
  it("fetches the version history alongside the section, not after it (finding 8)", async () => {
    const events = serve({ delayMs: 30 });
    const handler = await getTextTool();
    const result = await handler({ ...base, section: "§ 29" });
    const text = result.content[0].text;
    expect(text).toContain("(1) Text 29/1.");
    // The section is compared with the future version: here it reads the same, and the answer says so.
    expect(text).toContain("A future version of this act is already published (effective 2027-01-01): § 29 reads the same in it");
    expect(text).not.toContain("⚠");
    const historyStart = events.findIndex((e) => e.kind === "historie" && e.at === "start");
    const lastFragmentEnd = events.map((e) => e.kind === "fragmenty" && e.at === "end").lastIndexOf(true);
    expect(historyStart).toBeGreaterThanOrEqual(0);
    expect(historyStart).toBeLessThan(lastFragmentEnd);
    // One detail for the version read, one for the future version it is compared with.
    expect(events.filter((e) => e.kind === "detail" && e.at === "start")).toHaveLength(2);
  });

  it("says which of the sections read differ in the published future version", async () => {
    // § 29 gets a second paragraph from 2027, § 30 is repealed, § 28 stays.
    serve({ future: [...fragmentsOf(["28"]), ...fragmentsOf(["29"], 2)] });
    const handler = await getTextTool();
    const one = (await handler({ ...base, section: "§ 29" })).content[0].text;
    expect(one).toContain('⚠ A future version of this act is already published (effective 2027-01-01): § 29 DIFFERS in it (changed or no longer there) — read the new wording with date: "2027-01-01".');
    expect(one).toContain("(1) Text 29/1.");
    expect(one).not.toContain("Text 29/2.");
    const several = (await handler({ ...base, section: "§ 28-30" })).content[0].text;
    expect(several).toContain('§ 29, § 30 DIFFER in it (changed or no longer there) — read the new wording with date: "2027-01-01". § 28 reads the same.');
  });

  it("asks the detail once even when it fails, and still reads the text", async () => {
    const events = serve({ detail: () => new Response(JSON.stringify({ chyby: [{ popis: "Chyba" }] })) });
    const handler = await getTextTool();
    const result = await handler({ ...base, section: "29" });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("(1) Text 29/1.");
    expect(events.filter((e) => e.kind === "detail" && e.at === "start")).toHaveLength(1);
  });

  it("makes no request at all for an invalid label", async () => {
    const events = serve();
    const handler = await getTextTool();
    const result = await handler({ ...base, section: "odst. 2" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('"odst. 2" is not a valid section label.');
    expect(events).toHaveLength(0);
  });

  it("names the section with its sign, however it was passed", async () => {
    serve();
    const handler = await getTextTool();
    const text = (await handler({ ...base, section: "29" })).content[0].text;
    expect(text.startsWith("/sb/2012/89/2026-01-01 § 29 — in force 2026-01-01 – (open) (AKTUALNI) (via scan):")).toBe(true);
  });

  it("the continuation of a long section repeats section and date (finding 10)", async () => {
    // One § of ~72k characters: two windows.
    const long = [
      { kodTypuFragmentu: "Paragraf", zkracenaCitace: "§ 29 zákona č. 89/2012 Sb.", xhtml: "§ 29" },
      ...Array.from({ length: 72 }, (_, k) => ({
        kodTypuFragmentu: "Odstavec_Dc",
        zkracenaCitace: `§ 29 odst. ${k + 1} zákona č. 89/2012 Sb.`,
        xhtml: `(${k + 1}) ${"x".repeat(990)}`,
      })),
      ...fragmentsOf(["30"]),
    ];
    serve({ seznam: long });
    const handler = await getTextTool();
    const text = (await handler({ ...base, section: "§ 29", date: "2026-03-01" })).content[0].text;
    expect(text).toMatch(/pokračuj bez ptaní: section: "§ 29", date: "2026-03-01", page: 2\./);
    expect(text).not.toContain("call again with page: 2 for the rest");
    const last = (await handler({ ...base, section: "§ 29", date: "2026-03-01", page: 2 })).content[0].text;
    expect(last).not.toContain("pokračuj bez ptaní");
  });
});

describe("esbirka_get_text several sections", () => {
  it("a range and a list read in one answer, under one header; a missing § is named", async () => {
    serve();
    const handler = await getTextTool();
    const text = (await handler({ ...base, section: "§ 28-30" })).content[0].text;
    expect(text.split("\n")[0]).toContain("§ 28, § 29, § 30");
    expect(text).toContain("Text 28/1.");
    expect(text).toContain("Text 30/1.");
    expect(text.match(/A future version/g)).toHaveLength(1);
    expect(text).toContain("§ 28, § 29, § 30 read the same in it");
    const listed = (await handler({ ...base, section: "29, 31" })).content[0].text;
    expect(listed).toContain("Text 29/1.");
    expect(listed).toContain("Not in this act and time version: 31.");
  });

  it("expandSections: ranges, lists, the cap", async () => {
    const { expandSections } = await import("@/src/mcp/tools/esbirka");
    expect(expandSections("§ 2288-2291")).toEqual(["§ 2288", "§ 2289", "§ 2290", "§ 2291"]);
    expect(expandSections("2235, 2291; čl. 36")).toEqual(["2235", "2291", "čl. 36"]);
    expect(expandSections("§ 12")).toEqual(["§ 12"]);
    expect(() => expandSections("§ 1-30")).toThrow(/at most 10/);
  });
});

describe("esbirka_get_text whole act", () => {
  it("the continuation of a dated read repeats the date (finding 10)", async () => {
    const big = Array.from({ length: 70 }, (_, i) => ({ kodTypuFragmentu: "Odstavec_Dc", xhtml: `${i} ${"x".repeat(990)}` }));
    serve({ seznam: big });
    const handler = await getTextTool();
    const dated = (await handler({ ...base, date: "2015-06-01" })).content[0].text;
    expect(dated).toContain('(continue with date: "2015-06-01", page: 2; to read one provision, pass section: "§ N" instead)');
    const today = (await handler(base)).content[0].text;
    expect(today).toContain('(continue with page: 2; to read one provision, pass section: "§ N" instead)');
  });
});
