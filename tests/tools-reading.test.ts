import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * What the *_get_* tools put in their TEXT — the only half a client reads.
 * The link to cite and the way on to the rest of a decision must be there;
 * both used to ride in structured output alone, which clients never showed.
 */

vi.mock("@/src/sources/ns", async () => ({
  ...(await vi.importActual<typeof import("@/src/sources/ns")>("@/src/sources/ns")),
  getNsDecision: vi.fn(),
}));
vi.mock("@/src/sources/nss", async () => ({
  ...(await vi.importActual<typeof import("@/src/sources/nss")>("@/src/sources/nss")),
  getNssDecision: vi.fn(),
}));
vi.mock("@/src/sources/nalus", async () => ({
  ...(await vi.importActual<typeof import("@/src/sources/nalus")>("@/src/sources/nalus")),
  getNalusDecision: vi.fn(),
}));

import { getNsDecision } from "@/src/sources/ns";
import { getNssDecision } from "@/src/sources/nss";
import { getNalusDecision } from "@/src/sources/nalus";
import { registerNs } from "@/src/mcp/tools/ns";
import { registerNss } from "@/src/mcp/tools/nss";
import { registerNalus } from "@/src/mcp/tools/nalus";

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;

function handlerOf(register: (server: never) => void, name: string): Handler {
  const handlers: Record<string, Handler> = {};
  register({
    registerTool(toolName: string, _config: unknown, handler: Handler) {
      handlers[toolName] = handler;
    },
  } as never);
  return handlers[name];
}

const UNID = "0123456789ABCDEF0123456789ABCDEF";
const NS_URL = `https://sbirka.nsoud.cz/?OpenDocument&unid=${UNID}`;
const reasoning = "Odůvodnění rozhodnutí o vydržení vlastnického práva. ".repeat(20);

afterEach(() => {
  vi.clearAllMocks();
});

describe("ns_get_decision", () => {
  it("carries the link to cite — and with find, the one that opens at the passage", async () => {
    vi.mocked(getNsDecision).mockResolvedValue({
      unid: UNID,
      url: NS_URL,
      metadata: { "Spisová značka": "22 Cdo 1234/2025" },
      text: reasoning,
    } as never);
    const handler = handlerOf(registerNs as never, "ns_get_decision");

    const plain = (await handler({ unid: UNID, page: 1 })).content[0].text;
    expect(plain).toContain(`Spisová značka: 22 Cdo 1234/2025\n${NS_URL}\n`);

    const found = (await handler({ unid: UNID, page: 1, find: "vydržení" })).content[0].text;
    expect(found).toContain(`${NS_URL}&Highlight=0,${encodeURIComponent("vydržení")} (opens at the found passage)`);
    expect(found).toContain("(Excerpts only,");

    // No match, no promise of a passage.
    const missed = (await handler({ unid: UNID, page: 1, find: "promlčení" })).content[0].text;
    expect(missed).toContain(`Spisová značka: 22 Cdo 1234/2025\n${NS_URL}\n`);
    expect(missed).not.toContain("Highlight");
  });

  it("asks for the next page of a long decision, without asking the user", async () => {
    vi.mocked(getNsDecision).mockResolvedValue({
      unid: UNID,
      url: NS_URL,
      metadata: {},
      text: "Odstavec odůvodnění. ".repeat(4_000),
    } as never);
    const text = (await handlerOf(registerNs as never, "ns_get_decision")({ unid: UNID, page: 1 })).content[0].text;
    expect(text).toContain("(page 1/2 — continue without asking the user: page: 2. A decision you rely on is read to its last page");
  });
});

describe("nss_get_decision", () => {
  it("carries the link to cite", async () => {
    vi.mocked(getNssDecision).mockResolvedValue({
      id: "784744",
      url: "https://vyhledavac.nssoud.cz/DokumentDetail/Index/784744",
      metadata: { "Spisová značka": "1 As 25/2024" },
      text: reasoning,
    } as never);
    const text = (await handlerOf(registerNss as never, "nss_get_decision")({ document_id: "784744", page: 1 })).content[0].text;
    expect(text).toContain("Spisová značka: 1 As 25/2024\nhttps://vyhledavac.nssoud.cz/DokumentDetail/Index/784744\n");
  });
});

describe("us_get_decision", () => {
  const decision = {
    sz: "1-709-05",
    url: "https://nalus.usoud.cz/Search/GetText.aspx?sz=1-709-05",
    registrySign: "I.ÚS 709/05 ze dne 25. 4. 2006",
    form: "NÁLEZ",
    legalSentence: "Přistoupení České republiky k Evropské unii …",
    text: reasoning,
  };

  it("carries the link, the právní věta and a real abstract on the first read", async () => {
    vi.mocked(getNalusDecision).mockResolvedValue({ ...decision, abstract: "Stěžovatel napadl usnesení o vykonatelnosti." } as never);
    const handler = handlerOf(registerNalus as never, "us_get_decision");
    const first = (await handler({ sz: "1-709-05", page: 1 })).content[0].text;
    expect(first).toContain("I.ÚS 709/05 ze dne 25. 4. 2006\nNÁLEZ\nhttps://nalus.usoud.cz/Search/GetText.aspx?sz=1-709-05");
    expect(first).toContain("Právní věta:\n> Přistoupení");
    expect(first).toContain("Abstrakt:\nStěžovatel napadl");

    // A later read keeps the link and drops the long headers.
    const found = (await handler({ sz: "1-709-05", page: 1, find: "vydržení" })).content[0].text;
    expect(found).toContain(decision.url);
    expect(found).not.toContain("Právní věta:");
    expect(found).not.toContain("Abstrakt:");
  });

  it("skips NALUS's placeholder for a missing abstract", async () => {
    vi.mocked(getNalusDecision).mockResolvedValue({ ...decision, abstract: "Abstrakt není k dispozici." } as never);
    const text = (await handlerOf(registerNalus as never, "us_get_decision")({ sz: "1-709-05", page: 1 })).content[0].text;
    expect(text).not.toContain("Abstrakt");
  });
});
