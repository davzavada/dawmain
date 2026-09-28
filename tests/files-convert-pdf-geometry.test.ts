import { describe, expect, it } from "vitest";
import { continues, emitDmd, noteText } from "@/src/files/convert/pdf/emit";
import {
  collectRefs,
  footnoteSize,
  isNoteSized,
  labelStart,
  resolvePageNotes,
  zoneCandidates,
} from "@/src/files/convert/pdf/footnotes";
import {
  bodyStats,
  buildRows,
  buildSegments,
  dominantSize,
  hyphenDictionary,
  makeLine,
  needsSpace,
  runsText,
  runsToParts,
  splitColumns,
  takeMarginNumbers,
  textEdges,
} from "@/src/files/convert/pdf/geometry";
import { collapseLetterSpacing, detectHeadings, isTocLine } from "@/src/files/convert/pdf/headings";
import { cleanLabel, computeLabels } from "@/src/files/convert/pdf/labels";
import type { Line, Note, PageModel, Row, Run } from "@/src/files/convert/pdf/model";
import { detectFurniture, detectWatermarks, pageNumberIn, type PrintedNumber } from "@/src/files/convert/pdf/zones";
import { parseDmd } from "@/src/files/dmd/parse";
import { PAGE_FLAGS } from "@/src/files/dmd/types";
import { filler, lineItems, synPage, type SynLine } from "./fixtures/files/pdf/synthetic";

/**
 * The stages of the PDF layout engine one by one: geometry (rows,
 * superscripts, statistics, margins, columns, lines), page furniture,
 * labels, footnotes, headings and the DMD writer.
 */

const run = (str: string, x: number, o: Partial<Run> = {}): Run => ({
  str,
  x,
  x1: x + str.length * 5,
  y: 100,
  size: 10,
  font: "Serif",
  bold: false,
  sup: false,
  spaceBefore: false,
  spaceAfter: false,
  ...o,
});
const rowOf = (lines: SynLine[], ord = 1) => buildRows(synPage(ord, lines)).rows;
const lineOf = (l: SynLine, col = { left: 70, right: 525 }, mn: string | null = null): Line =>
  makeLine(1, 0, rowOf([l])[0].runs, col, mn);

describe("buildRows", () => {
  it("groups items by baseline and attaches superscripts, also from a row of their own", () => {
    const rows = rowOf([{ y: 100, text: "odpovědnost{12} škůdce" }, { y: 113, text: "další řádek" }]);
    expect(rows).toHaveLength(2);
    expect(rows[0].runs.map((r) => [r.str, r.sup])).toEqual([["odpovědnost", false], ["12", true], ["škůdce", false]]);
    expect(rows[0].y).toBe(100);
    expect(rows[0].size).toBe(10);
  });

  it("attaches a note label set left of its line", () => {
    const rows = buildRows({ ord: 1, width: 595, height: 842, items: [
      { str: "1", x: 70, y: 737, w: 3, h: 5, size: 5, font: "S" },
      { str: "Srov. rozsudek", x: 82, y: 740, w: 60, h: 8, size: 8, font: "S" },
    ] }).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].runs.map((r) => [r.str, r.sup])).toEqual([["1", true], ["Srov. rozsudek", false]]);
  });

  it("treats a same-size raised label as a superscript but not a raised word", () => {
    const rows = buildRows({ ord: 1, width: 595, height: 842, items: [
      { str: "text", x: 70, y: 100, w: 20, h: 10, size: 10, font: "S" },
      { str: "3", x: 90, y: 96.5, w: 5, h: 10, size: 10, font: "S" },
      { str: "dál", x: 97, y: 100, w: 15, h: 10, size: 10, font: "S" },
    ] }).rows;
    expect(rows[0].runs.map((r) => r.sup)).toEqual([false, true, false]);
  });

  it("drops empty, off-page and rotated items, dedupes fake bold, counts characters", () => {
    const res = buildRows({ ord: 1, width: 595, height: 842, items: [
      { str: "  ", x: 70, y: 100, w: 5, h: 10, size: 10, font: "S" },
      { str: "slovo", x: 70, y: 100, w: 25, h: 10, size: 10, font: "S" },
      { str: "slovo", x: 70.4, y: 100.3, w: 25, h: 10, size: 10, font: "S" },
      { str: "venku", x: 900, y: 100, w: 25, h: 10, size: 10, font: "S" },
      { str: "otočený", x: 560, y: 400, w: 25, h: 10, size: 10, font: "S", rotated: true },
      { str: "bez velikosti", x: 70, y: 200, w: 25, h: 0, size: 0, font: "S" },
      { str: "NaN", x: Number.NaN, y: 200, w: 25, h: 10, size: 10, font: "S" },
    ] });
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].runs.map((r) => r.str)).toEqual(["slovo"]);
    expect(res.rotated).toBe(1);
    expect(res.rawChars).toBe(10);
  });

  it("marks bold from the flag or the font name", () => {
    const rows = buildRows({ ord: 1, width: 595, height: 842, items: [
      { str: "a", x: 70, y: 100, w: 5, h: 10, size: 10, font: "Minion-Semibold" },
      { str: "b", x: 80, y: 100, w: 5, h: 10, size: 10, font: "Minion", bold: true },
      { str: "c", x: 90, y: 100, w: 5, h: 10, size: 10, font: "Minion" },
    ] }).rows;
    expect(rows[0].runs.map((r) => r.bold)).toEqual([true, true, false]);
  });
});

describe("run text", () => {
  it("dominantSize weights by characters", () => {
    expect(dominantSize([{ str: "aaaaaaaa", size: 10 }, { str: "b", size: 12 }])).toBe(10);
    expect(dominantSize([{ str: "a", size: 10.1 }, { str: "b", size: 10.2 }])).toBe(10.25);
  });

  it("needsSpace follows the extracted spaces and the gap", () => {
    expect(needsSpace(run("a", 70), run("b", 75.5))).toBe(false);
    expect(needsSpace(run("a", 70), run("b", 78))).toBe(true);
    expect(needsSpace(run("a", 70, { spaceAfter: true }), run("b", 75))).toBe(true);
    expect(needsSpace(run("a", 70), run("1", 75.5, { sup: true, size: 6 }))).toBe(false);
  });

  it("runsText and runsToParts keep superscripts apart", () => {
    const runs = [run("škody", 70), run("12", 95, { sup: true, size: 6 }), run("a¹", 110)];
    expect(runsText(runs)).toBe("škody12 a¹");
    expect(runsText(runs, false)).toBe("škody a¹");
    expect(runsToParts(runs)).toEqual([
      { t: "text", s: "škody" },
      { t: "sup", s: "12" },
      { t: "text", s: " a" },
      { t: "sup", s: "¹" },
    ]);
  });
});

describe("statistics and edges", () => {
  it("finds the body size, line spacing and bold share", () => {
    const rows = [rowOf([...filler(100, 10), { y: 300, text: "Nadpis", bold: true, size: 14 }, { y: 740, text: "poznámka dole", size: 8 }])];
    const stats = bodyStats(rows);
    expect(stats.bodySize).toBe(10);
    expect(stats.lineGap).toBe(13);
    expect(stats.boldShare).toBe(0);
    expect(bodyStats([]).bodySize).toBe(10);
    expect(bodyStats([[]]).lineGap).toBe(12);
  });

  it("finds the text edges per parity and ignores marginal numbers", () => {
    const pages = [1, 2].map((ord) => ({ ord, width: 595, rows: rowOf([...filler(100, 14, 0, { x: ord === 1 ? 80 : 60 }), { y: 100, text: "12", x: 40 }], ord) }));
    const edges = textEdges(pages, 10);
    expect(edges(1).left).toBe(80);
    expect(edges(2).left).toBe(60);
    expect(edges(1).right).toBeCloseTo(525, 0);
    expect(textEdges([{ ord: 1, width: 595, rows: [] }], 10)(1)).toEqual({ left: 0, right: 595 });
  });

  it("takes marginal numbers out of their rows, also when set on a row of their own", () => {
    const rows = rowOf([{ y: 100, text: "12", x: 40 }, { y: 100, text: "Text odstavce s marginálním číslem vlevo" }, { y: 131, text: "7", x: 540 }, { y: 130, text: "Jiný odstavec s číslem vpravo na okraji" }, { y: 160, text: "Poznámka", x: 20 }, { y: 160, text: "Řádek s textem na okraji, který zůstane" }]);
    const found = takeMarginNumbers(rows, { left: 70, right: 525 });
    expect([...found.values()]).toEqual([{ value: "12", side: "left" }, { value: "7", side: "right" }]);
    expect(rows.map((r) => r.runs[0].str)).toEqual(["Text", "Jiný", "Poznámka"]);
  });
});

describe("splitColumns / buildSegments / makeLine", () => {
  const twoCols = (): Row[] =>
    rowOf([
      { y: 70, text: "Název přes celou šířku stránky, který protíná střed stránky", x: 100 },
      ...[0, 1, 2, 3].flatMap((i): SynLine[] => [
        { y: 100 + i * 13, text: `levý sloupec řádek ${i} textu`, x: 70, justify: true, right: 290 },
        { y: 100 + i * 13, text: `pravý sloupec řádek ${i} textu`, x: 305, justify: true, right: 525 },
      ]),
    ]);

  it("splits a band with a gutter into two segments in reading order", () => {
    const res = splitColumns(twoCols(), { left: 70, right: 525 }, true);
    expect(res.columns).toBe(true);
    expect(res.unsure).toBe(false);
    expect(res.segments.map((s) => [s.band, s.col, s.rows.length])).toEqual([[0, 0, 1], [1, 0, 4], [1, 1, 4]]);
    const segments = buildSegments(res, 1, new Map());
    expect(segments[1].lines[0].text).toBe("levý sloupec řádek 0 textu");
    expect(segments[2].lines[0].colLeft).toBe(305);
  });

  it("keeps a single segment when disabled or when the text crosses the middle", () => {
    expect(splitColumns(twoCols(), { left: 70, right: 525 }, false).segments).toHaveLength(1);
    const single = splitColumns(rowOf(filler(100, 10)), { left: 70, right: 525 }, true);
    expect(single.columns).toBe(false);
    expect(single.segments).toHaveLength(1);
    expect(splitColumns([], { left: 70, right: 525 }, true).segments).toEqual([]);
  });

  it("gives a split row's marginal number to the column on its side", () => {
    const rows = twoCols();
    const mns = new Map<Row, { value: string; side: "left" | "right" }>([[rows[2], { value: "5", side: "right" }]]);
    const segments = buildSegments(splitColumns(rows, { left: 70, right: 525 }, true), 1, mns);
    expect(segments[1].lines[1].mn).toBeNull();
    expect(segments[2].lines[1].mn).toBe("5");
  });

  it("describes a line: style, bold lead, far page number", () => {
    const line = lineOf({ y: 100, text: "Obsah kapitoly" });
    expect(line).toMatchObject({ text: "Obsah kapitoly", plain: "Obsah kapitoly", size: 10, bold: false, boldLead: null, gapTail: false, mn: null });
    const lead = makeLine(1, 0, [run("14", 70, { bold: true }), run("Text", 85)], { left: 70, right: 525 }, null);
    expect(lead.boldLead).toBe("14");
    const toc = makeLine(1, 0, [run("Úvod", 70), run("12", 500)], { left: 70, right: 525 }, null);
    expect(toc.gapTail).toBe(true);
    expect(makeLine(1, 0, [run("Tučně", 70, { bold: true })], { left: 70, right: 525 }, "3")).toMatchObject({ bold: true, mn: "3" });
  });

  it("collects hyphenated compounds written mid-line", () => {
    const dict = hyphenDictionary([lineOf({ y: 100, text: "vztahy česko-slovenské a pracovně-" })]);
    expect([...dict]).toEqual(["cesko-slovenske"]);
  });
});

describe("page furniture", () => {
  const pages = (heads: string[], footers: Array<string | null>) =>
    heads.map((h, i) => ({ ord: i + 1, width: 595, height: 842, rows: rowOf([{ y: 40, text: h, size: 8 }, ...filler(100, 6, i), ...(footers[i] ? [{ y: 800, text: footers[i]!, size: 8, x: 290 }] : [])], i + 1) }));

  it("removes heads at a stable y with changing text and reads the page numbers", () => {
    const f = detectFurniture(pages(["Hlava I", "§ 12 Nadpis", "Hlava II"], ["45", "46", "47"]), 13, { bodySize: 10 });
    expect(f.removed.size).toBe(6);
    expect([...f.numbers.entries()]).toEqual([[1, [{ value: 45, roman: null }]], [2, [{ value: 46, roman: null }]], [3, [{ value: 47, roman: null }]]]);
    expect([...f.heads.entries()]).toEqual([[1, ["Hlava I"]], [2, ["§ 12 Nadpis"]], [3, ["Hlava II"]]]);
  });

  it("does not remove a large heading or an outline heading at the top of each page", () => {
    const ps = [1, 2, 3].map((ord) => ({ ord, width: 595, height: 842, rows: rowOf([{ y: 60, text: `Kapitola ${ord}`, size: 14 }, ...filler(100, 6)], ord) }));
    expect(detectFurniture(ps, 13, { bodySize: 10 }).removed.size).toBe(0);
    const small = [1, 2, 3].map((ord) => ({ ord, width: 595, height: 842, rows: rowOf([{ y: 60, text: `Oddíl ${ord}`, size: 10 }, ...filler(100, 6)], ord) }));
    expect(detectFurniture(small, 13, { bodySize: 10, isHeading: (_p, t) => t.startsWith("Oddíl") }).removed.size).toBe(0);
  });

  it("needs a page number or repeated text when only two pages agree", () => {
    expect(detectFurniture(pages(["Úvod do problematiky", "Jiný text nahoře"], [null, null]), 13, { bodySize: 10 }).removed.size).toBe(0);
    expect(detectFurniture(pages(["Právní rozhledy 3", "Právní rozhledy 4"], [null, null]), 13, { bodySize: 10 }).removed.size).toBe(2);
  });

  it("keeps footnote-like bottom rows unless they repeat, and reports lone numbers as loose", () => {
    const ps = [1, 2, 3].map((ord) => ({ ord, width: 595, height: 842, rows: rowOf([...filler(100, 6), { y: 800, text: `${ord} ${["Srov. rozsudek NS.", "Tamtéž.", "Viz výše uvedené."][ord - 1]}`, size: 8 }], ord) }));
    expect(detectFurniture(ps, 13, { bodySize: 10 }).removed.size).toBe(0);
    const one = [{ ord: 1, width: 595, height: 842, rows: rowOf([...filler(100, 6), { y: 800, text: "12", size: 8, x: 290 }]) }];
    const f = detectFurniture(one, 13, { bodySize: 10 });
    expect(f.removed.size).toBe(0);
    expect([...f.loose.values()]).toEqual([{ value: 12, roman: null }]);
  });

  it("always removes watermark text in the band and never keeps it as a head", () => {
    const one = [{ ord: 1, width: 595, height: 842, rows: rowOf([{ y: 30, text: "Licence pro jan@example.cz", size: 6 }, ...filler(100, 6)]) }];
    const f = detectFurniture(one, 13, { bodySize: 10 });
    expect(f.removed.size).toBe(1);
    expect(f.watermarks).toBe(1);
    expect(f.heads.size).toBe(0);
  });

  it("reads page numbers from head and footer texts", () => {
    const n = (t: string) => pageNumberIn(t);
    expect(n("245")).toEqual({ number: { value: 245, roman: null }, rest: "" });
    expect(n("– 245 –")?.number.value).toBe(245);
    expect(n("xii")).toEqual({ number: { value: null, roman: "xii" }, rest: "" });
    expect(n("Strana 3 z 10")).toEqual({ number: { value: 3, roman: null }, rest: "" });
    expect(n("s. 17")?.number.value).toBe(17);
    expect(n("3/10")?.number.value).toBe(3);
    expect(n("245 Právní rozhledy")).toEqual({ number: { value: 245, roman: null }, rest: "Právní rozhledy" });
    expect(n("§ 2913 Porušení povinnosti 1245")).toEqual({ number: { value: 1245, roman: null }, rest: "§ 2913 Porušení povinnosti" });
    expect(n("Hlava 2")).toBeNull();
    expect(n("§ 12")).toBeNull();
    expect(n("zákon č. 12")).toBeNull();
    expect(n("12 odst. 3")).toBeNull();
    expect(n("Právní rozhledy")).toBeNull();
    expect(n("iiii")).toBeNull();
  });

  it("finds watermark lines repeated at a stable position", () => {
    const ps = [1, 2, 3, 4].map((ord) => ({ ord, width: 595, height: 842, rows: rowOf([...filler(100, 4, ord), { y: 400, text: "Pouze pro interní potřebu", size: 9 }, ...filler(450, 2, ord)], ord) }));
    const found = detectWatermarks(ps, new Set());
    expect([...found].map((r) => r.y)).toEqual([400, 400, 400, 400]);
    const moving = ps.map((p, i) => ({ ...p, rows: rowOf([...filler(100, 4, p.ord), { y: 300 + i * 40, text: "Pouze pro interní potřebu", size: 9 }], p.ord) }));
    expect(detectWatermarks(moving, new Set()).size).toBe(0);
    const email = ps.slice(0, 2).map((p) => ({ ...p, rows: rowOf([{ y: 300 + p.ord * 50, text: "stáhnuto: jan@example.cz", size: 9 }], p.ord) }));
    expect(detectWatermarks(email, new Set()).size).toBe(2);
  });
});

describe("labels", () => {
  const nums = (entries: Array<[number, number | string]>) =>
    new Map<number, PrintedNumber[]>(entries.map(([ord, v]) => [ord, [typeof v === "number" ? { value: v, roman: null } : { value: null, roman: v }]]));

  it("cleans /PageLabels entries", () => {
    expect(cleanLabel("12")).toBe("12");
    expect(cleanLabel(" A 1 ")).toBe("A-1");
    expect(cleanLabel("x/y")).toBe("xy");
    expect(cleanLabel("")).toBeNull();
    expect(cleanLabel("///")).toBeNull();
    expect(cleanLabel("abcdefghijklmnop")).toBe("abcdefghijkl");
  });

  it("prefers calibration, then non-trivial /PageLabels, then printed numbers, then physical", () => {
    const printed = nums([[1, 11], [2, 12], [3, 13]]);
    const base = { count: 3, printed, textPages: [1, 2, 3] };
    expect(computeLabels({ ...base, pdfLabels: ["a", "b", "c"], calibration: 99 })).toMatchObject({ source: "printed", labels: ["100", "101", "102"], offset: 99 });
    expect(computeLabels({ ...base, pdfLabels: ["a", "b", "c"] })).toMatchObject({ source: "pdf_labels", labels: ["a", "b", "c"] });
    expect(computeLabels({ ...base, pdfLabels: ["1", "2", "3"] })).toMatchObject({ source: "printed", labels: ["11", "12", "13"], offset: 10 });
    expect(computeLabels({ ...base, printed: new Map(), pdfLabels: null })).toMatchObject({ source: "physical", labels: ["1", "2", "3"] });
    // Mostly invalid /PageLabels are ignored.
    expect(computeLabels({ ...base, pdfLabels: ["", "", "c"] }).source).toBe("printed");
  });

  it("fills gaps and flags them; Roman front matter counts as agreeing", () => {
    const res = computeLabels({ count: 6, pdfLabels: null, printed: nums([[1, "i"], [2, "ii"], [3, 1], [5, 3], [6, 4]]), textPages: [1, 2, 3, 4, 5, 6] });
    expect(res.labels).toEqual(["i", "ii", "1", "2", "3", "4"]);
    expect(res.flags.map((f) => f & PAGE_FLAGS.LABEL_GUESSED)).toEqual([0, 0, 0, PAGE_FLAGS.LABEL_GUESSED, 0, 0]);
  });

  it("votes over every number a page carries", () => {
    const printed = new Map<number, PrintedNumber[]>([
      [1, [{ value: 2, roman: null }, { value: 101, roman: null }]],
      [2, [{ value: 102, roman: null }]],
      [3, [{ value: 7, roman: null }, { value: 103, roman: null }]],
    ]);
    expect(computeLabels({ count: 3, pdfLabels: null, printed, textPages: [1, 2, 3] }).labels).toEqual(["101", "102", "103"]);
  });

  it("requires 70 % agreement", () => {
    expect(computeLabels({ count: 4, pdfLabels: null, printed: nums([[1, 5], [2, 6], [3, 90], [4, 1]]), textPages: [1, 2, 3, 4] }).source).toBe("physical");
    expect(computeLabels({ count: 1, pdfLabels: null, printed: nums([[1, 7]]), textPages: [1] }).labels).toEqual(["7"]);
  });
});

describe("footnote helpers", () => {
  const L = (text: string, y: number, size = 8, x = 70): Line => lineOf({ y, text, size, x });

  it("finds the footnote size below the body and requires it on ≥ 8 % of pages", () => {
    const page = rowOf([...filler(100, 6), { y: 740, text: "1 Poznámka dole", size: 8 }, { y: 750, text: "2 Další", size: 8 }]);
    expect(footnoteSize([page], 10)).toBe(8);
    const plain = Array.from({ length: 30 }, () => rowOf(filler(100, 6)));
    expect(footnoteSize([page, ...plain], 10)).toBeNull();
    expect(footnoteSize([], 10)).toBeNull();
    expect(isNoteSized(L("x", 1, 8.5), 8)).toBe(true);
    expect(isNoteSized(L("x", 1, 9), 8)).toBe(false);
  });

  it("finds the zone at the bottom of each column", () => {
    const body = [L("Tělo", 100, 10), L("Tělo", 113, 10)];
    const segs = [{ left: 70, right: 525, lines: [...body, L("1 Poznámka", 740), L("pokračuje", 750)] }];
    expect(zoneCandidates(segs, 8, 13)).toEqual([[0, 2]]);
    // Too close to the body: no zone.
    expect(zoneCandidates([{ left: 70, right: 525, lines: [...body, L("1 malé", 120)] }], 8, 13)).toEqual([]);
    // Body text below the small block: no zone.
    expect(zoneCandidates([{ left: 70, right: 525, lines: [L("Tělo", 100, 10), L("malé", 300)] }, { left: 70, right: 525, lines: [L("Tělo", 500, 10)] }], 8, 13)).toEqual([]);
    // A whole segment of notes under an earlier band.
    expect(zoneCandidates([{ left: 70, right: 525, lines: body }, { left: 70, right: 525, lines: [L("1 Poznámka", 740)] }], 8, 13)).toEqual([[1, 0]]);
  });

  it("turns label-like superscripts into references", () => {
    const line = makeLine(1, 0, [run("škody", 70), run("1,2", 95, { sup: true, size: 6 }), run("m", 120), run("st", 126, { sup: true, size: 6 })], { left: 70, right: 525 }, null);
    const refs = collectRefs([line]);
    expect(refs.map((r) => r.label)).toEqual(["1", "2", "st"]);
    expect(line.parts.filter((p) => p.t === "ref")).toHaveLength(3);
  });

  it("decides which zone lines start a note", () => {
    const sup = makeLine(1, 0, [run("7", 70, { sup: true, size: 5 }), run("Text", 80)], { left: 70, right: 525 }, null);
    expect(labelStart(sup, null, new Set())).toMatchObject({ label: "7", sup: true, rest: [{ t: "text", s: "Text" }] });
    expect(labelStart(L("1 Srov.", 1), null, new Set())?.label).toBe("1");
    expect(labelStart(L("4) Viz", 1), "3", new Set())?.label).toBe("4");
    expect(labelStart(L("4)Viz", 1), "3", new Set())?.rest).toEqual([{ t: "text", s: "Viz" }]);
    expect(labelStart(L("9 Srov.", 1), "3", new Set())).toBeNull();
    expect(labelStart(L("9 Srov.", 1), "3", new Set(["9"]))?.label).toBe("9");
    expect(labelStart(L("9 Srov.", 1), "3", new Set(), (l) => l === "9")?.label).toBe("9");
    expect(labelStart(L("* Autor", 1), null, new Set(["*"]))?.label).toBe("*");
    expect(labelStart(L("2019 bylo", 1), "3", new Set())).toBeNull();
    expect(labelStart(L("text", 1), null, new Set())).toBeNull();
  });

  it("resolves a page: binding, continuation, unsure pages", () => {
    const body = [makeLine(1, 0, [run("škoda", 70), run("1", 97, { sup: true, size: 6 }), run("a", 105), run("2", 112, { sup: true, size: 6 })], { left: 70, right: 525 }, null)];
    const refs = collectRefs(body);
    const prev: Note = { label: "9", page: 0, lines: [L("začátek bez tečky", 1)], bound: true };
    const res = resolvePageNotes({ page: 1, zone: [L("pokračování.", 730), L("1 První.", 740), L("2 Druhá.", 750)], body, refs, prev });
    expect(res).toMatchObject({ zone: true, unsure: false, labelled: 2, bound: 2, consecutive: true });
    expect(prev.lines).toHaveLength(2);
    expect(refs.every((r) => r.note !== null)).toBe(true);

    const refs2 = collectRefs([makeLine(1, 0, [run("text", 70)], { left: 70, right: 525 }, null)]);
    const unsure = resolvePageNotes({ page: 1, zone: [L("{3} a", 740), L("{7} b", 750)], body: [], refs: refs2, prev: null });
    expect(unsure).toMatchObject({ zone: true, unsure: true, notes: [], labelled: 2, bound: 0 });
    expect(unsure.endText).toHaveLength(2);

    expect(resolvePageNotes({ page: 1, zone: [], body: [], refs: [], prev: null }).zone).toBe(false);
    expect(resolvePageNotes({ page: 1, zone: [L("Související ustanovení", 740)], body: [], refs: [], prev: null }).zone).toBe(false);
  });
});

describe("headings helpers", () => {
  it("collapses letter spacing", () => {
    expect(collapseLetterSpacing("Č Á S T  P R V N Í")).toBe("ČÁST PRVNÍ");
    expect(collapseLetterSpacing("§ 2913 a násl.")).toBe("§ 2913 a násl.");
  });

  it("recognises TOC and index lines", () => {
    expect(isTocLine({ plain: "§ 2913 Porušení ........ 1245", gapTail: false })).toBe(true);
    expect(isTocLine({ plain: "Úvod … 12", gapTail: false })).toBe(true);
    expect(isTocLine({ plain: "odpovědnost za škodu 12, 45, 67", gapTail: false })).toBe(true);
    expect(isTocLine({ plain: "Úvod", gapTail: true })).toBe(true);
    expect(isTocLine({ plain: "Soud rozhodl ve věci sp. zn. 25 Cdo 1234/2019.", gapTail: false })).toBe(false);
  });

  it("detects headings on a model page and reports the source", () => {
    const lines = [
      lineOf({ y: 80, text: "§ 12", bold: true, x: 280 }),
      ...filler(110, 4).map((l) => lineOf(l)),
    ];
    const page: PageModel = { ord: 1, width: 595, height: 842, label: "1", flags: 0, segments: [{ band: 0, col: 0, left: 70, right: 525, lines }], notes: [], endText: [], heads: ["§ 20–25"], kept: true };
    const report = detectHeadings([page], [], { bodySize: 10, lineGap: 13, boldShare: 0.05 });
    expect(report).toMatchObject({ from: "patterns", count: 1, rejectedPar: 0 });
    expect(lines[0].heading).toMatchObject({ kind: "par", level: 1, text: "§ 12" });
    // § 12 is outside the § range its running head names.
    expect(page.flags & PAGE_FLAGS.HEADING_UNSURE).toBeTruthy();
  });
});

describe("DMD writer", () => {
  const ctx = { bodySize: 10, lineGap: 13, justified: true };

  it("continues a paragraph within a column unless a break signal appears", () => {
    const a = lineOf({ y: 100, text: "první řádek odstavce, který vede až k pravému okraji sazby", justify: true });
    expect(continues(a, lineOf({ y: 113, text: "a pokračuje" }), ctx)).toBe(true);
    expect(continues(a, lineOf({ y: 130, text: "po mezeře" }), ctx)).toBe(false);
    expect(continues(a, lineOf({ y: 113, text: "odsazený", x: 90 }), ctx)).toBe(false);
    expect(continues(a, lineOf({ y: 113, text: "menší", size: 8 }), ctx)).toBe(false);
    expect(continues(a, lineOf({ y: 113, text: "• odrážka" }), ctx)).toBe(false);
    expect(continues(a, { ...lineOf({ y: 113, text: "s číslem" }), mn: "3" }, ctx)).toBe(false);
    const short = lineOf({ y: 100, text: "Řádek, který v sazbě na prapor nedosahuje k pravému okraji a končí tečkou." });
    expect(continues(short, lineOf({ y: 113, text: "Nový odstavec" }), ctx)).toBe(false);
    // Ragged-right text: only a clearly short line ends a paragraph.
    expect(continues(short, lineOf({ y: 113, text: "Další věta" }), { ...ctx, justified: false })).toBe(true);
    expect(continues(lineOf({ y: 100, text: "Konec." }), lineOf({ y: 113, text: "Další" }), { ...ctx, justified: false })).toBe(false);
  });

  it("continues across a page only when the sentence runs on", () => {
    const end = { ...lineOf({ y: 700, text: "věta, která pokračuje", justify: true }), page: 1 };
    const next = { ...lineOf({ y: 100, text: "na další straně" }), page: 2 };
    expect(continues(end, next, ctx)).toBe(true);
    const done = { ...lineOf({ y: 700, text: "Věta skončila.", justify: true }), page: 1 };
    expect(continues(done, { ...lineOf({ y: 100, text: "Nová věta" }), page: 2 }, ctx)).toBe(false);
    expect(continues(done, { ...lineOf({ y: 100, text: "odst. 2 pokračuje" }), page: 2 }, ctx)).toBe(true);
    expect(continues(end, { ...lineOf({ y: 100, text: "odsazený začátek", x: 90 }), page: 2 }, ctx)).toBe(false);
  });

  it("joins a note's lines", () => {
    const note: Note = { label: "1", page: 1, lines: [lineOf({ y: 1, text: "Srov. povin-" }), lineOf({ y: 2, text: "nosti a m{2}" })], bound: true };
    expect(noteText(note, new Set())).toBe("Srov. povinnosti a m²");
    expect(noteText({ ...note, lines: [] }, new Set())).toBe("");
  });

  it("writes a paged document the parser reads back", () => {
    const l1 = lineOf({ y: 100, text: "Text [s. 5] s odkazem", justify: true });
    const note: Note = { label: "1", page: 1, lines: [lineOf({ y: 740, text: "Poznámka." })], bound: true };
    l1.parts.push({ t: "ref", label: "1", raw: "1", note });
    const pages: PageModel[] = [
      { ord: 1, width: 595, height: 842, label: "7", flags: 0, segments: [{ band: 0, col: 0, left: 70, right: 525, lines: [l1] }], notes: [note], endText: [], heads: [], kept: true },
      { ord: 2, width: 595, height: 842, label: "8", flags: 0, segments: [], notes: [], endText: [], heads: [], kept: true },
      { ord: 3, width: 595, height: 842, label: "9", flags: 0, segments: [], notes: [], endText: [], heads: [], kept: false },
    ];
    const out = emitDmd(pages, { ...ctx, dict: new Set(), marginalNumbers: true });
    expect(out.dmd).toBe("[s. 7]\n\nText \\[s. 5] s odkazem[^1]\n\n[^1]: Poznámka.\n\n[s. 8]\n");
    const parsed = parseDmd(out.dmd);
    expect(parsed.pages.map((p) => p.label)).toEqual(["7", "8"]);
    expect(parsed.footnotes[0].refAt).not.toBeNull();
  });
});

describe("synthetic helper", () => {
  it("draws words and superscripts as separate items", () => {
    expect(lineItems({ y: 100, text: "a{1} b" }).map((i) => [i.str, i.size])).toEqual([["a", 10], ["1", 6], ["b", 10]]);
  });
});
