import { describe, expect, it } from "vitest";
import { booleanFromString, clampedInt, queriesFromInput, sourcesFromInput } from "@/src/mcp/tools/shared";
import { registerCzCaselaw } from "@/src/mcp/tools/cz-caselaw";

/**
 * A refused input is an isError answer, which Claude.ai shows the user only
 * as "This tool could not complete its request". Inputs whose meaning is
 * plain are read as meant instead.
 */

describe("lenient input helpers", () => {
  it("clampedInt: numeric strings and out-of-range numbers become the clamped integer", () => {
    const limit = clampedInt(1, 10);
    expect(limit("5")).toBe(5);
    expect(limit(20)).toBe(10);
    expect(limit(0)).toBe(1);
    expect(limit(2.6)).toBe(3);
    expect(limit("pět")).toBe("pět");
    expect(limit(undefined)).toBeUndefined();
  });

  it("booleanFromString", () => {
    expect(booleanFromString("true")).toBe(true);
    expect(booleanFromString(" FALSE ")).toBe(false);
    expect(booleanFromString("ano")).toBe("ano");
    expect(booleanFromString(true)).toBe(true);
  });

  it("queriesFromInput: JSON text or one string becomes a list, capped, short entries dropped", () => {
    const queries = queriesFromInput(3);
    expect(queries('["a b", "c d"]')).toEqual(["a b", "c d"]);
    expect(queries("náhrada škody")).toEqual(["náhrada škody"]);
    expect(queries('"bezpečný přístav" NEAR hosting')).toEqual(['"bezpečný přístav" NEAR hosting']);
    expect(queries(["a b", "c d", "e f", "g h"])).toEqual(["a b", "c d", "e f"]);
    expect(queries(["x", " ", "ok"])).toEqual(["ok"]);
    expect(queries([])).toBeUndefined();
    expect(queries(undefined)).toBeUndefined();
  });

  it("sourcesFromInput: strings split, case and diacritics folded, aliases mapped, unknown names kept", () => {
    const sources = sourcesFromInput({ cjeu: "sdeu" });
    expect(sources("NS, ÚS")).toEqual(["ns", "us"]);
    expect(sources('["nss","CJEU"]')).toEqual(["nss", "sdeu"]);
    expect(sources(["ns", "NS"])).toEqual(["ns"]);
    expect(sources(["krajske"])).toEqual(["krajske"]);
    expect(sources("")).toBeUndefined();
  });
});

describe("caselaw_search input schema", () => {
  let schema: { safeParse: (value: unknown) => { success: boolean; data?: Record<string, unknown> } } | undefined;
  registerCzCaselaw({
    registerTool: (_name: string, config: { inputSchema: typeof schema }) => {
      schema = config.inputSchema;
    },
  } as never);

  it("reads overshooting and stringified inputs as meant", () => {
    const parsed = schema!.safeParse({
      queries: '["náhrada škody", "náhrady škody", "škoda", "újma"]',
      per_source_limit: 20,
      read_top: "2",
      include_eu: "true",
      sources: "NS, ÚS, cjeu",
      eu_court: "c",
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({
      queries: ["náhrada škody", "náhrady škody", "škoda"],
      per_source_limit: 10,
      read_top: 2,
      include_eu: true,
      sources: ["ns", "us", "sdeu"],
      eu_court: "C",
      include_regional: false,
    });
  });

  it("keeps the defaults and still refuses an unknown court", () => {
    expect(schema!.safeParse({ query: "nájem" }).data).toMatchObject({ per_source_limit: 5, read_top: 0, include_eu: false });
    expect(schema!.safeParse({ query: "nájem", sources: ["krajske"] }).success).toBe(false);
  });
});
