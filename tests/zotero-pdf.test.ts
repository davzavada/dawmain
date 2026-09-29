import { PDFDocument, PDFHexString, StandardFonts, rgb } from "pdf-lib";
import { beforeAll, describe, expect, it } from "vitest";
import { LIMITS } from "@/src/zotero/config";
import { pdfText, type PdfTextResult } from "@/src/zotero/pdf-text";

/**
 * Text of a Zotero PDF attachment (src/zotero/pdf-text.ts) through the
 * Vlastní zdroje converter, rendered like files_get_document: page
 * markers ⟦s. N⟧, bounded page range, and an explicit "unavailable" for a
 * password, a scan, a broken file and a spent budget. The PDFs are built
 * here with pdf-lib (standard Helvetica — no font files needed).
 */

/** Czech-like text without diacritics (WinAnsi), with enough stop words for the converter's scan check. */
const PAGE_TEXT = [
  [
    "Nejvyssi soud se zabyval otazkou, zda je zalobce opravnen pozadovat",
    "nahradu nemajetkove ujmy v penezich a v jake vysi ji lze priznat.",
    "Soud prvniho stupne zalobe vyhovel a odvolaci soud jeho rozsudek potvrdil.",
  ],
  [
    "Dovolani je pripustne, nebot napadene rozhodnuti zavisi na vyreseni",
    "otazky hmotneho prava, ktera v rozhodovaci praxi dovolaciho soudu",
    "dosud nebyla vyresena a je treba ji posoudit jinak nez dosud.",
  ],
  [
    "Z techto duvodu Nejvyssi soud rozsudek odvolaciho soudu zrusil a vec",
    "mu vratil k dalsimu rizeni, v nemz bude vazan pravnim nazorem",
    "vyslovenym v tomto rozhodnuti a rozhodne i o nakladech rizeni.",
  ],
];

async function textPdf(pages: string[][], top = 760): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create();
  doc.setProducer("pdf-lib");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const lines of pages) {
    const page = doc.addPage([595, 842]);
    lines.forEach((line, i) => page.drawText(line, { x: 72, y: top - i * 16, size: 11, font }));
  }
  return toBuffer(await doc.save({ useObjectStreams: false }));
}

/** Pages with only a drawn rectangle — what a scanner without OCR produces. */
async function scanPdf(): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create();
  doc.setProducer("Canon iR-ADV C5535");
  for (let i = 0; i < 2; i++) {
    doc.addPage([595, 842]).drawRectangle({ x: 60, y: 60, width: 475, height: 722, color: rgb(0.93, 0.93, 0.9) });
  }
  return toBuffer(await doc.save({ useObjectStreams: false }));
}

/**
 * A Standard security handler whose /U entry cannot match the empty
 * password, so a reader must ask for one (as scripts/make-pdf-fixtures.mjs
 * builds encrypted.pdf; the content itself is never reached).
 */
async function encryptedPdf(): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([595, 842]).drawText("Tajny text", { x: 72, y: 700, size: 12, font });
  const ctx = doc.context;
  const hex = (byte: string, n: number) => PDFHexString.of(byte.repeat(n));
  ctx.trailerInfo.Encrypt = ctx.register(ctx.obj({ Filter: "Standard", V: 1, R: 2, Length: 40, O: hex("4f", 32), U: hex("55", 32), P: -3904 }));
  ctx.trailerInfo.ID = ctx.obj([hex("ab", 16), hex("ab", 16)]);
  return toBuffer(await doc.save({ useObjectStreams: false }));
}

function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function ok(result: PdfTextResult): Extract<PdfTextResult, { text: string }> {
  if ("unavailable" in result) throw new Error(`unavailable: ${result.unavailable}`);
  return result;
}

describe("pdfText", () => {
  let three: ArrayBuffer;
  beforeAll(async () => {
    three = await textPdf(PAGE_TEXT);
  });

  it("extracts a 3-page PDF with a page marker before each page's text", async () => {
    const r = ok(await pdfText(three));
    expect(r.pages).toBe(3);
    expect(r.pageRange).toEqual([1, 3]);
    const markers = [...r.text.matchAll(/⟦s\. (\d+)⟧/g)].map((m) => m[1]);
    expect(markers).toEqual(["1", "2", "3"]);
    const at = (s: string) => r.text.indexOf(s);
    expect(at("⟦s. 1⟧")).toBeLessThan(at("Nejvyssi soud se zabyval"));
    expect(at("Nejvyssi soud se zabyval")).toBeLessThan(at("⟦s. 2⟧"));
    expect(at("⟦s. 2⟧")).toBeLessThan(at("Dovolani je pripustne"));
    expect(at("⟦s. 3⟧")).toBeLessThan(at("Z techto duvodu"));
    // Lines of one paragraph are joined, no DMD markup leaks ("[s. 1]").
    expect(r.text).toContain("zda je zalobce opravnen pozadovat nahradu nemajetkove ujmy");
    expect(r.text).not.toMatch(/^\[s\. /m);
    // No printed page numbers: the markers are the PDF's own order, and the warning says so.
    expect(r.warnings.some((w) => w.includes("pořadí strany v PDF"))).toBe(true);
    // The caller's buffer is still usable (pdf.js got a copy).
    expect(three.byteLength).toBeGreaterThan(0);
  });

  it("reads only the requested page range", async () => {
    const r = ok(await pdfText(three, { pageRange: [2, 2] }));
    expect(r.pages).toBe(3);
    expect(r.pageRange).toEqual([2, 2]);
    expect(r.text).toContain("⟦s. 2⟧");
    expect(r.text).toContain("Dovolani je pripustne");
    expect(r.text).not.toContain("Nejvyssi soud se zabyval");
    expect(r.text).not.toContain("Z techto duvodu");

    const tail = ok(await pdfText(three, { pageRange: [3, 2] }));
    expect(tail.pageRange).toEqual([2, 3]);
    expect([...tail.text.matchAll(/⟦s\. (\d+)⟧/g)].map((m) => m[1])).toEqual(["2", "3"]);
  });

  it("clamps a range past the end of the file", async () => {
    const r = ok(await pdfText(three, { pageRange: [2, 1000] }));
    expect(r.pageRange).toEqual([2, 3]);
    expect(r.warnings.some((w) => w.startsWith("Přečteny strany"))).toBe(false);
    const past = ok(await pdfText(three, { pageRange: [7, 9] }));
    expect(past.text).toBe("");
    expect(past.pages).toBe(3);
    expect(past.pageRange[0]).toBeGreaterThan(past.pageRange[1]);
    expect(past.warnings[0]).toContain("jen 3 strany");
  });

  it(`reads at most LIMITS.maxPdfPages pages per call and says where it stopped`, async () => {
    // Body text mid-page: a line repeated at the top of every page would be taken for a running head.
    const long = await textPdf(
      Array.from({ length: LIMITS.maxPdfPages + 2 }, (_, i) => [`Strana ${i + 1} obsahuje text, ktery se ma v tomto dokumentu cist.`, ...PAGE_TEXT[i % 3]]),
      500,
    );
    const r = ok(await pdfText(long));
    expect(r.pages).toBe(LIMITS.maxPdfPages + 2);
    expect(r.pageRange).toEqual([1, LIMITS.maxPdfPages]);
    expect(r.text).toContain(`Strana ${LIMITS.maxPdfPages} obsahuje`);
    expect(r.text).not.toContain(`Strana ${LIMITS.maxPdfPages + 1} obsahuje`);
    expect(r.warnings).toContain(`Přečteny strany 1–${LIMITS.maxPdfPages} z ${LIMITS.maxPdfPages + 2}; najednou lze vytáhnout nejvýš ${LIMITS.maxPdfPages} stran.`);
    const rest = ok(await pdfText(long, { pageRange: [LIMITS.maxPdfPages + 1, 10_000] }));
    expect(rest.pageRange).toEqual([LIMITS.maxPdfPages + 1, LIMITS.maxPdfPages + 2]);
    expect(rest.warnings.some((w) => w.startsWith("Přečteny strany"))).toBe(false);
  }, 30_000);

  it("says a password-protected PDF is encrypted", async () => {
    expect(await pdfText(await encryptedPdf())).toEqual({ unavailable: "encrypted" });
  });

  it("says bytes that are not a PDF are broken", async () => {
    expect(await pdfText(new TextEncoder().encode("toto neni PDF, jen text").buffer as ArrayBuffer)).toEqual({ unavailable: "broken" });
    expect(await pdfText(three.slice(0, 200))).toEqual({ unavailable: "broken" });
  });

  it("says a PDF without a text layer is a scan", async () => {
    expect(await pdfText(await scanPdf())).toEqual({ unavailable: "scan" });
  });

  it("gives up as a timeout when the caller's budget is already spent", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    expect(await pdfText(three, { signal: ctrl.signal })).toEqual({ unavailable: "timeout" });
  });
});
