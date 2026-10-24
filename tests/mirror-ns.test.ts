import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseNsViewPage } from "@/src/mirror/crawl/ns";
import { mapNs, markNsPictures, nsCaseNumbers, parseNsMarked, takeNsMarkers } from "@/src/mirror/map/ns";
import { parseNsDecision } from "@/src/sources/ns";

const fixture = (...p: string[]) => readFileSync(path.join(__dirname, "fixtures", ...p), "utf8");

describe("NS view (ReadViewEntries JSON, live 24. 10. 2026)", () => {
  it("lists UNIDs with case numbers and the view's total", () => {
    const page = parseNsViewPage(fixture("mirror", "ns-view-page.json"));
    expect(page.total).toBeGreaterThan(160_000);
    expect(page.entries).toHaveLength(3);
    expect(page.entries[0]).toEqual({ unid: "00007CCB5DBCB0F0C1257F6F00369EAE", caseNumber: "23 Cdo 3470/2015" });
    for (const e of page.entries) expect(e.unid).toMatch(/^[0-9A-F]{32}$/);
  });
});

describe("NS pictures", () => {
  it("marks the content picture (the emblem), not UI icons, and keeps the text as parseNsDecision gives it", () => {
    const html = fixture("ns-webprint-legacy.html");
    const { html: marked, pictures } = markNsPictures(html);
    expect(pictures).toHaveLength(1);
    expect(pictures[0]).toMatchObject({ width: 105, height: 119 });
    expect(pictures[0].url).toMatch(/^https:\/\/rozhodnuti\.nsoud\.cz\/Judikatura\/judikatura_ns\.nsf\/.+FieldElemFormat=gif$/);
    const { decision, offsets } = parseNsMarked(marked, "X", 1);
    expect(decision.text).toBe(parseNsDecision(html, "X").text);
    expect(offsets).toEqual([0]); // above the opening, which the parser cuts
    expect(markNsPictures(fixture("ns-websearch-legacy.html")).pictures).toEqual([]); // ecblank.gif is chrome
  });

  it("gives a picture inside the text its offset and removes the marker", () => {
    const { text, offsets } = takeNsMarkers("Odůvodnění:\n 0 \nTabulka níže.\n1Konec.", 2);
    expect(text).toBe("Odůvodnění:\n\nTabulka níže.\nKonec.");
    expect(text.slice(0, offsets[0])).toBe("Odůvodnění:\n"); // on its own line
    expect(text.slice(offsets[1])).toBe("Konec.");
  });
});

describe("mapNs", () => {
  it("maps the metadata table to the base record", () => {
    const html = fixture("ns-webprint-projednal.html");
    const record = mapNs("abc".padEnd(32, "0"), parseNsDecision(html, "X"), "ns:webprint", []);
    expect(record).toMatchObject({
      source: "ns",
      sourceId: "ABC".padEnd(32, "0"),
      court: "Nejvyšší soud",
      caseNumber: "4 Tdo 466/2026",
      caseNumbers: ["4 Tdo 466/2026"],
      decisionType: "usneseni",
      decidedOn: "2026-06-17",
      ecli: "ECLI:CZ:NS:2026:4.TDO.466.2026.1",
      parserVersion: 1,
      images: [],
    });
    expect(record.text?.source).toBe("ns:webprint");
    expect(record.text!.body).toMatch(/^Nejvyšší soud/);
  });

  it("splits several case numbers", () => {
    expect(nsCaseNumbers("21 Cdo 1234/2019, 21 Cdo 1235/2019")).toEqual(["21 Cdo 1234/2019", "21 Cdo 1235/2019"]);
    expect(nsCaseNumbers(undefined)).toEqual([]);
  });
});
