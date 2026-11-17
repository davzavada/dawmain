import { afterEach, describe, expect, it, vi } from "vitest";
import { SourceError } from "@/src/sources/shared/errors";
import {
  SLOVLEX_GATEWAY,
  SLOVLEX_ZBIERKA,
  actIri,
  parseActCitation,
  slovlexJson,
  todayIso,
} from "@/src/sources/slovlex-base";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("actIri / parseActCitation", () => {
  it("builds the IRI with and without a version", () => {
    expect(actIri(1964, 40)).toBe("/SK/ZZ/1964/40");
    expect(actIri(1964, 40, "20260731")).toBe("/SK/ZZ/1964/40/20260731");
  });

  it("reads citations and IRIs", () => {
    expect(parseActCitation("40/1964 Zb.")).toEqual({ year: 1964, number: 40 });
    expect(parseActCitation("40/1964 Zb.")).toEqual({ year: 1964, number: 40 });
    expect(parseActCitation("325/2025 Z. z.")).toEqual({ year: 2025, number: 325 });
    expect(parseActCitation("40/1964")).toEqual({ year: 1964, number: 40 });
    expect(parseActCitation("/SK/ZZ/1964/40")).toEqual({ year: 1964, number: 40 });
    expect(parseActCitation("/SK/ZZ/1964/40/20260731")).toEqual({ year: 1964, number: 40 });
    expect(parseActCitation("https://www.slov-lex.sk/ezbierky/pravne-predpisy/SK/ZZ/2025/325/20290901")).toEqual({ year: 2025, number: 325 });
    expect(parseActCitation("Občiansky zákonník")).toBeNull();
    expect(parseActCitation("40/64")).toBeNull();
  });
});

describe("todayIso", () => {
  it("is the date in Europe/Prague", () => {
    expect(todayIso(new Date("2026-11-17T22:30:00Z"))).toBe("2026-11-17");
    expect(todayIso(new Date("2026-11-17T23:30:00Z"))).toBe("2026-11-18");
    expect(todayIso()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("slovlexJson", () => {
  const url = `${SLOVLEX_GATEWAY}/internal/elegislativa/legislativne-materialy/filter?page=1&size=1`;

  it("POSTs a JSON body and parses the answer", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ totalElements: 3 }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchSpy);
    const json = await slovlexJson<{ totalElements: number }>(SLOVLEX_ZBIERKA, url, { method: "POST", body: { hladanyVyraz: "daň" }, retry: true });
    expect(json.totalElements).toBe(3);
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ hladanyVyraz: "daň" }));
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect((init.headers as Record<string, string>).accept).toBe("application/json");
  });

  const failing = async (status: number, body = "") => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status })));
    try {
      await slovlexJson(SLOVLEX_ZBIERKA, url, { retry: false });
    } catch (error) {
      return error as SourceError;
    }
    throw new Error("expected a SourceError");
  };

  it("maps 404 → NOT_FOUND, 401 → PARSE_DRIFT, 400 → UPSTREAM_ERROR, non-JSON → PARSE_DRIFT", async () => {
    expect((await failing(404)).kind).toBe("NOT_FOUND");
    const drift = await failing(401);
    expect(drift.kind).toBe("PARSE_DRIFT");
    expect(drift.message).toContain("401, když chybí povinný parametr");
    expect((await failing(400)).kind).toBe("UPSTREAM_ERROR");
    expect((await failing(503)).kind).toBe("UPSTREAM_ERROR");
    expect((await failing(200, "<!doctype html><html></html>")).kind).toBe("PARSE_DRIFT");
  });
});
