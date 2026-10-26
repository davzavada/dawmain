import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cellarChoiceParts } from "@/src/sources/cellar";

/** Cellar's HTTP 300 bodies: alternative renditions vs. parts of one document. */

const live = readFileSync(path.join(__dirname, "fixtures", "mirror", "cellar-300-62011CJ0241.html"), "utf8");

describe("cellarChoiceParts", () => {
  it("reads ONE rendition of two alternatives, its http link upgraded to https (live 62011CJ0241)", () => {
    expect(cellarChoiceParts(live)).toEqual([
      "https://publications.europa.eu/resource/cellar/344b66e2-91af-4258-9c37-9929d976a2da.0012.02/DOC_2",
    ]);
  });

  it("orders the parts of a multi-part manifestation by stream_order", () => {
    const item = (doc: number, order: number) =>
      `<li title="item"><a href="http://publications.europa.eu/resource/cellar/x.0001.01/DOC_${doc}">…</a><ul><li title="stream_order" id="streamOrder">${order}</li></ul></li>`;
    const body = `<ul><li title="manifestation">cellar:x.0001.01<ul>${item(2, 2)}${item(1, 1)}${item(3, 3)}</ul></li></ul>`;
    expect(cellarChoiceParts(body).map((u) => u.slice(-5))).toEqual(["DOC_1", "DOC_2", "DOC_3"]);
  });

  it("takes every link of a plain listing, and never a link to another host", () => {
    const body = `<a href="https://publications.europa.eu/resource/cellar/a/DOC_1">1</a><a href="https://evil.example/x">x</a><a href="http://publications.europa.eu/resource/cellar/a/DOC_2">2</a>`;
    expect(cellarChoiceParts(body)).toEqual([
      "https://publications.europa.eu/resource/cellar/a/DOC_1",
      "https://publications.europa.eu/resource/cellar/a/DOC_2",
    ]);
    expect(cellarChoiceParts("<html>nothing</html>")).toEqual([]);
  });
});
