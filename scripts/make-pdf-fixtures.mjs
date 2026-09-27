#!/usr/bin/env node
/**
 * Generate the small, realistic PDFs the PDF-converter tests read
 * (tests/files-convert-pdf-pdfjs.test.ts) into tests/fixtures/files/pdf/:
 *
 *  commentary.pdf  4 pages of a Beck-style commentary: running heads whose
 *                  text changes from page to page, § headings with their
 *                  bracketed titles, statute wording in smaller type,
 *                  marginal numbers in the margin, superscript footnote
 *                  references with small-type notes at the bottom (one note
 *                  continuing onto the next page, one "4)"-style label),
 *                  words hyphenated at line ends (also the Czech repeated
 *                  hyphen) and across a page break, printed page numbers
 *                  1245–1248, a buyer watermark line and rotated margin text;
 *  journal-2col.pdf 2 journal pages set in two columns under a full-width
 *                  title, /PageLabels starting at 417, notes across the
 *                  page bottom;
 *  word-tagged.pdf a tagged, Word-like document: /MarkInfo, a structure
 *                  tree with marked content, bookmarks (the PDF outline),
 *                  ragged-right paragraphs with spacing, no page numbers;
 *  scan.pdf        pages without any text layer (must be rejected);
 *  encrypted.pdf   a user-password-protected file (must be rejected).
 *
 * Text is set with DejaVu Serif (Czech diacritics) from
 * /usr/share/fonts/truetype/dejavu, subset-embedded with @pdf-lib/fontkit.
 * Dates are fixed; pdf-lib names font subsets randomly, so the bytes differ
 * between runs — the tests depend on the content only.
 * Usage: node scripts/make-pdf-fixtures.mjs
 */

import fontkit from "@pdf-lib/fontkit";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { degrees, PDFDocument, PDFHexString, PDFName, PDFOperator, PDFOperatorNames, rgb } from "pdf-lib";

const OUT = path.resolve(import.meta.dirname, "../tests/fixtures/files/pdf");
const FONTS = "/usr/share/fonts/truetype/dejavu";
const FIXED_DATE = new Date("2026-01-15T10:00:00Z");

async function newDoc({ title, author, producer, creator }) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const regular = await doc.embedFont(readFileSync(path.join(FONTS, "DejaVuSerif.ttf")), { subset: true });
  const bold = await doc.embedFont(readFileSync(path.join(FONTS, "DejaVuSerif-Bold.ttf")), { subset: true });
  doc.setTitle(title);
  doc.setAuthor(author);
  doc.setProducer(producer);
  doc.setCreator(creator);
  doc.setCreationDate(FIXED_DATE);
  doc.setModificationDate(FIXED_DATE);
  return { doc, regular, bold };
}

/**
 * Draw one line of text at (x, top-origin baseline y). Words are drawn one
 * by one so the line can be justified to `right`; "{12}" after a word draws
 * a superscript. Returns the right edge.
 */
function drawLine(page, text, o) {
  const { x, y, size, font, right, supFont = o.font } = o;
  const H = page.getHeight();
  const supSize = Math.round(size * 0.62 * 100) / 100;
  const tokens = text
    .split(" ")
    .filter(Boolean)
    .map((w) => {
      const m = /^(.*?)\{([^}]+)\}(.*)$/.exec(w);
      return m ? { word: m[1], sup: m[2], after: m[3] } : { word: w, sup: null, after: "" };
    });
  const widthOf = (t) =>
    font.widthOfTextAtSize(t.word, size) + (t.sup ? supFont.widthOfTextAtSize(t.sup, supSize) : 0) + (t.after ? font.widthOfTextAtSize(t.after, size) : 0);
  const natural = tokens.reduce((n, t) => n + widthOf(t), 0);
  const space = font.widthOfTextAtSize(" ", size);
  let gap = space;
  if (right !== undefined && tokens.length > 1) {
    gap = (right - x - natural) / (tokens.length - 1);
    if (gap < space * 0.8) throw new Error(`line too long (${Math.round(x + natural + space * (tokens.length - 1))} > ${right}): ${text}`);
  }
  let cx = x;
  for (const t of tokens) {
    if (t.word) {
      page.drawText(t.word, { x: cx, y: H - y, size, font });
      cx += font.widthOfTextAtSize(t.word, size);
    }
    if (t.sup) {
      page.drawText(t.sup, { x: cx + 0.3, y: H - y + size * 0.36, size: supSize, font: supFont });
      cx += supFont.widthOfTextAtSize(t.sup, supSize) + 0.3;
    }
    if (t.after) {
      page.drawText(t.after, { x: cx, y: H - y, size, font });
      cx += font.widthOfTextAtSize(t.after, size);
    }
    cx += gap;
  }
  return cx - gap;
}

/** Lines of a paragraph, justified except the last; returns the y after it. */
function drawPara(page, lines, o) {
  const { y, gap } = o;
  lines.forEach((text, i) => {
    const last = i === lines.length - 1;
    drawLine(page, text, { ...o, y: y + i * gap, x: o.x + (i === 0 ? (o.indent ?? 0) : 0), right: last && !o.fullLast ? undefined : o.right });
  });
  return y + lines.length * gap;
}

/** A centred line (a "{*}" superscript allowed, as in drawLine). */
function centered(page, text, { y, size, font, left, right }) {
  const w = font.widthOfTextAtSize(text.replace(/\{[^}]+\}/g, ""), size);
  drawLine(page, text, { x: left + (right - left - w) / 2, y, size, font });
}

// ─────────────────────────────────────────────────────────────── commentary

async function commentary() {
  const { doc, regular, bold } = await newDoc({
    title: "Občanský zákoník VI. Závazkové právo. Komentář",
    author: "Petrov, Výtisk, Beran a kol.",
    producer: "Adobe PDF Library 17.0",
    creator: "Adobe InDesign 18.0",
  });
  const W = 520;
  const H = 720;
  const BODY = 10;
  const GAP = 13;
  const FN = 8;
  const FNGAP = 10;
  const frame = (n) => (n % 2 === 1 ? { left: 70, right: 474 } : { left: 50, right: 454 });
  const heads = [
    "Díl 2 · Následky porušení smluvní povinnosti",
    "§ 2913 · Porušení smluvní povinnosti",
    "Díl 3 · Odpovědnost za jiného",
    "§ 2914 · Odpovědnost za jiného",
  ];

  const pages = [];
  for (let n = 1; n <= 4; n++) {
    const page = doc.addPage([W, H]);
    const { left, right } = frame(n);
    drawLine(page, heads[n - 1], { x: left, y: 40, size: 8, font: regular });
    centered(page, String(1244 + n), { y: 688, size: 8, font: regular, left, right });
    centered(page, "Licence pro: Jan Novák, jan.novak@example.cz, obj. č. 2026-0412", { y: 706, size: 6, font: regular, left, right });
    page.drawText("Zakoupeno: jan.novak@example.cz", { x: W - 14, y: 200, size: 6, font: regular, rotate: degrees(90), color: rgb(0.6, 0.6, 0.6) });
    pages.push({ page, left, right });
  }
  const body = (p, lines, y, extra = {}) => drawPara(p.page, lines, { x: p.left, right: p.right, y, gap: GAP, size: BODY, font: regular, ...extra });
  const mn = (p, value, y) => {
    const w = bold.widthOfTextAtSize(value, 9);
    p.page.drawText(value, { x: p.left - 16 - w, y: H - y, size: 9, font: bold });
  };
  const notes = (p, lines, y) => drawPara(p.page, lines, { x: p.left, right: p.right, y, gap: FNGAP, size: FN, font: regular, fullLast: false });
  const center = (p, text, y, size, font) => centered(p.page, text, { y, size, font, left: p.left, right: p.right });

  // Page 1245
  let p = pages[0];
  center(p, "§ 2913", 84, 11, bold);
  center(p, "[Porušení smluvní povinnosti]", 99, BODY, bold);
  drawPara(p.page, [
    "(1) Poruší-li strana povinnost ze smlouvy, nahradí škodu z toho vzniklou druhé",
    "straně smlouvy nebo i osobě, které ze splnění smluvené povinnosti měl zřejmě",
    "vzniknout prospěch.",
  ], { x: p.left, right: p.right, y: 121, gap: 11.5, size: 9, font: regular });
  drawLine(p.page, "I. Obecně", { x: p.left, y: 172, size: BODY, font: bold });
  mn(p, "1", 192);
  let y = body(p, [
    "Ustanovení upravuje odpovědnost za porušení smluvní povinnosti.{1} Jde",
    "o odpovědnost objektivní, které se škůdce může zprostit jen z důvodů, jež",
    "zákon výslovně připouští. Obdobně to ostatně dovozovala již starší česko-",
    "-slovenská judikatura k dřívější úpravě, podle níž bylo porušení povin-",
    "nosti předpokladem vzniku odpovědnosti bez ohledu na zavinění.",
  ], 192);
  mn(p, "2", y);
  body(p, [
    "Podle ustálené judikatury{2} musí poškozený prokázat porušení povinnosti,",
    "vznik škody a příčinnou souvislost mezi nimi. Škůdce se může zprostit",
    "povinnosti k náhradě, prokáže-li, že mu ve splnění povinnosti ze smlouvy",
    "dočasně nebo trvale zabránila mimořádná nepředvídatelná a nepřekonatelná",
    "překážka vzniklá nezávisle na jeho vůli. Rozsah náhrady určuje obecná úprava",
    "a také ustanovení o předvídatelnosti škody, které omezuje rozsah od-",
  ], y, { fullLast: true });
  notes(p, [
    "{1} Srov. rozsudek NS ze dne 12. 3. 2019, sp. zn. 25 Cdo 1234/2019, a dále",
    "rozsudek NS ze dne 4. 6. 2020, sp. zn. 25 Cdo 2345/2020.",
  ], 626);
  notes(p, [
    "2 MELZER, F. In: PETROV, J., VÝTISK, M., BERAN, V. a kol. Občanský zákoník.",
    "Komentář. 2. vydání. Praha: C. H. Beck, 2019, s. 1245, kde se výklad",
  ], 646);

  // Page 1246
  p = pages[1];
  y = body(p, [
    "povědnosti na škodu, kterou škůdce mohl při uzavření smlouvy předvídat jako",
    "možný následek porušení své povinnosti. Na to navazuje § 2910 o odpovědnosti",
    "za zásah do absolutních práv, který se uplatní vedle smluvní odpovědnosti.",
  ], 72);
  drawLine(p.page, "II. Předpoklady odpovědnosti", { x: p.left, y: y + 14, size: BODY, font: bold });
  mn(p, "3", y + 34);
  body(p, [
    "Předpokladem odpovědnosti je porušení povinnosti ze smlouvy,{3} vznik škody",
    "a příčinná souvislost. Zavinění se nevyžaduje, škůdce se však může zprostit",
    "z důvodů uvedených v odstavci 2, které vykládá judikatura restriktivně.",
  ], y + 34);
  notes(p, ["dále rozvádí i ve vztahu k § 2910."], 636);
  notes(p, ["{3} Tamtéž, s. 1250."], 656);

  // Page 1247
  p = pages[2];
  center(p, "§ 2914", 84, 11, bold);
  center(p, "[Odpovědnost za jiného]", 99, BODY, bold);
  drawPara(p.page, [
    "Kdo při své činnosti použije zmocněnce, zaměstnance nebo jiného pomocníka,",
    "nahradí škodu jím způsobenou stejně, jako by ji způsobil sám.",
  ], { x: p.left, right: p.right, y: 121, gap: 11.5, size: 9, font: regular });
  drawLine(p.page, "I. Obecně", { x: p.left, y: 160, size: BODY, font: bold });
  mn(p, "1", 180);
  y = body(p, [
    "Ustanovení zakládá odpovědnost za pomocníka{4)} bez ohledu na to, zda",
    "pomocník sám splňuje předpoklady odpovědnosti. Rozhodující je, že škodu",
    "způsobil při činnosti, ke které jej škůdce použil.",
  ], 180);
  mn(p, "2", y);
  body(p, [
    "Za pomocníka se považuje i ten, kdo pro škůdce jedná jen příležitostně.",
  ], y);
  notes(p, ["4) Viz též § 2914 odst. 2 a výklad k § 2915."], 656);

  // Page 1248
  p = pages[3];
  mn(p, "3", 72);
  body(p, [
    "Odpovědnost podle tohoto ustanovení je objektivní.{5} Škůdce se nemůže",
    "zprostit poukazem na pečlivý výběr pomocníka ani na dohled nad ním.",
  ], 72);
  notes(p, ["{5} Srov. rozsudek NS sp. zn. 25 Cdo 3456/2021."], 656);

  return doc.save({ useObjectStreams: false });
}

// ─────────────────────────────────────────────────────────────── journal, two columns

async function journal() {
  const { doc, regular, bold } = await newDoc({
    title: "Náhrada nemajetkové újmy v judikatuře",
    author: "Jana Nováková",
    producer: "Acrobat Distiller 23.0",
    creator: "QuarkXPress 2023",
  });
  const W = 595;
  const H = 842;
  const L = { left: 56, right: 292 };
  const R = { left: 303, right: 539 };
  const SIZE = 10.5;
  const GAP = 13;
  const col = (page, c, lines, y, extra = {}) => drawPara(page, lines, { x: c.left, right: c.right, y, gap: GAP, size: SIZE, font: regular, ...extra });

  const p1 = doc.addPage([W, H]);
  drawLine(p1, "Právní rozhledy 12/2019", { x: 56, y: 40, size: 8, font: regular });
  drawLine(p1, "417", { x: 525, y: 40, size: 8, font: regular });
  centered(p1, "Náhrada nemajetkové újmy v judikatuře", { y: 86, size: 16, font: bold, left: 56, right: 539 });
  centered(p1, "Jana Nováková{*}", { y: 108, size: 11, font: regular, left: 56, right: 539 });
  drawLine(p1, "1. Úvod", { x: L.left, y: 140, size: 10, font: bold });
  col(p1, L, [
    "Náhrada nemajetkové újmy patří k nejvíce",
    "diskutovaným institutům nového soukro-",
    "mého práva. Zákonodárce v ní opustil",
    "tarifní přístup a svěřil určení výše",
    "náhrady úvaze soudu.{1} Soudy však",
    "dlouho hledaly měřítka, podle nichž mají",
    "výši náhrady určovat tak, aby byla",
    "přiměřená a předvídatelná pro obě strany",
    "sporu. Metodika Nejvyššího soudu",
    "k náhradě nemajetkové újmy na zdraví",
    "přinesla bodové ohodnocení, které",
    "se stalo východiskem i pro další",
  ], 158, { fullLast: true });
  col(p1, R, [
    "případy, například pro náhradu duševních",
    "útrap pozůstalých, kde soudy vycházejí",
    "z pevné částky a tu upravují podle",
    "okolností případu. Tento přístup je",
    "v souladu s požadavkem, aby obdobné",
    "případy byly rozhodovány obdobně.",
    "V dalším textu se zaměřím na to, jak",
    "soudy s těmito měřítky zacházejí",
    "a jaké otázky zůstávají otevřené",
    "zejména u újmy na svobodě a na cti,",
    "kde žádná metodika dosud chybí a kde",
    "se rozhodování nejvíce rozchází.",
  ], 140, { fullLast: false });
  drawPara(p1, ["* Autorka je advokátkou v Praze."], { x: 56, y: 770, gap: 10, size: 8, font: regular });
  drawPara(p1, ["1 Srov. nález ÚS ze dne 3. 2. 2020, sp. zn. II. ÚS 1234/19, bod 24."], { x: 56, y: 780, gap: 10, size: 8, font: regular });

  const p2 = doc.addPage([W, H]);
  drawLine(p2, "418", { x: 56, y: 40, size: 8, font: regular });
  drawLine(p2, "Nováková: Náhrada nemajetkové újmy", { x: 380, y: 40, size: 8, font: regular });
  drawLine(p2, "2. Újma na zdraví", { x: L.left, y: 80, size: 10, font: bold });
  col(p2, L, [
    "U újmy na zdraví se soudy řídí metodikou,",
    "která oceňuje bolest a ztížení společenského",
    "uplatnění body. Hodnota bodu se odvozuje",
    "od průměrné mzdy.{2} Tím je zajištěna",
    "aktualizace částek bez zásahu zákono-",
  ], 98, { fullLast: true });
  col(p2, R, [
    "dárce. Kritici namítají, že metodika",
    "vede k mechanickému rozhodování, soudy",
    "ji však mohou modifikovat podle okolností.",
    "Tak se děje zejména u těžkých újem.",
  ], 80);
  drawPara(p2, ["2 Srov. rozsudek NS ze dne 17. 6. 2021, sp. zn. 25 Cdo 1111/2021."], { x: 56, y: 780, gap: 10, size: 8, font: regular });

  doc.catalog.set(PDFName.of("PageLabels"), doc.context.obj({ Nums: [0, { S: "D", St: 417 }] }));
  return doc.save({ useObjectStreams: false });
}

// ─────────────────────────────────────────────────────────────── Word-like tagged document

async function word() {
  const { doc, regular, bold } = await newDoc({
    title: "Odpovědnost za škodu ze smlouvy",
    author: "Petr Svoboda",
    producer: "Microsoft® Word pro Microsoft 365",
    creator: "Microsoft® Word pro Microsoft 365",
  });
  const ctx = doc.context;
  const W = 595;
  const H = 842;
  const LEFT = 72;
  const RIGHT = 523;
  const SIZE = 11;
  const GAP = 13.4;
  const AFTER = 8;
  const structRoot = ctx.nextRef();
  const elems = [];
  const pageRefs = [];

  let mcid = 0;
  const tagged = (page, pageIdx, role, draw) => {
    const id = mcid++;
    page.pushOperators(PDFOperator.of(PDFOperatorNames.BeginMarkedContentSequence, [PDFName.of(role), ctx.obj({ MCID: id })]));
    draw();
    page.pushOperators(PDFOperator.of(PDFOperatorNames.EndMarkedContent));
    elems.push({ role, pageIdx, mcid: id });
  };
  const para = (page, pageIdx, lines, y) => {
    tagged(page, pageIdx, "P", () => drawPara(page, lines, { x: LEFT, y, gap: GAP, size: SIZE, font: regular }));
    return y + lines.length * GAP + AFTER;
  };
  const heading = (page, pageIdx, text, y, size) => {
    tagged(page, pageIdx, size >= 14 ? "H1" : "H2", () => drawLine(page, text, { x: LEFT, y, size, font: bold }));
    return y + size * 1.2 + 10;
  };
  const note = (page, pageIdx, text, y) => {
    tagged(page, pageIdx, "Note", () => drawLine(page, text, { x: LEFT, y, size: 9, font: regular }));
  };
  const rule = (page, y) => page.drawLine({ start: { x: LEFT, y: H - y }, end: { x: LEFT + 144, y: H - y }, thickness: 0.5 });

  const p1 = doc.addPage([W, H]);
  const p2 = doc.addPage([W, H]);
  pageRefs.push(p1.ref, p2.ref);

  let y = 90;
  y = heading(p1, 0, "1. Úvod", y, 14);
  y = para(p1, 0, [
    "Tento text shrnuje pravidla odpovědnosti za škodu způsobenou",
    "porušením smluvní povinnosti podle občanského zákoníku.{1}",
    "Zaměřuje se na předpoklady odpovědnosti a na liberační důvody.",
  ], y);
  y = para(p1, 0, [
    "Výklad vychází z aktuální judikatury Nejvyššího soudu a z odborné",
    "literatury, kterou cituji v poznámkách.",
  ], y);
  y = heading(p1, 0, "2. Právní rozbor", y + 6, 14);
  para(p1, 0, [
    "Odpovědnost za porušení smluvní povinnosti je objektivní. Škůdce",
    "se jí zprostí jen tehdy, prokáže-li mimořádnou nepředvídatelnou",
    "a nepřekonatelnou překážku.{2}",
  ], y);
  rule(p1, 736);
  note(p1, 0, "1 Zákon č. 89/2012 Sb., občanský zákoník, ve znění pozdějších předpisů.", 752);
  note(p1, 0, "2 Srov. § 2913 odst. 2 občanského zákoníku.", 764);

  y = 90;
  y = heading(p2, 1, "2.1 Předvídatelnost škody", y, 12);
  y = para(p2, 1, [
    "Rozsah náhrady omezuje pravidlo předvídatelnosti. Škůdce hradí jen",
    "škodu, kterou mohl při uzavření smlouvy předvídat.{3}",
  ], y);
  y = heading(p2, 1, "3. Závěr", y + 6, 14);
  para(p2, 1, [
    "Smluvní odpovědnost je přísnější než odpovědnost deliktní, protože",
    "nevyžaduje zavinění.",
  ], y);
  rule(p2, 748);
  note(p2, 1, "3 Srov. § 2913 odst. 1 a § 2894 občanského zákoníku.", 764);

  // Structure tree: StructTreeRoot → Document → one element per marked-content sequence.
  const docElem = ctx.nextRef();
  const kids = elems.map((e) =>
    ctx.register(ctx.obj({ Type: "StructElem", S: e.role, P: docElem, Pg: pageRefs[e.pageIdx], K: e.mcid })),
  );
  ctx.assign(docElem, ctx.obj({ Type: "StructElem", S: "Document", P: structRoot, K: kids }));
  const parentTree = [];
  for (let i = 0; i < 2; i++) {
    parentTree.push(i, ctx.obj(elems.map((e, k) => (e.pageIdx === i ? kids[k] : null)).filter(Boolean)));
  }
  ctx.assign(structRoot, ctx.obj({ Type: "StructTreeRoot", K: docElem, ParentTree: ctx.obj({ Nums: parentTree }) }));
  p1.node.set(PDFName.of("StructParents"), ctx.obj(0));
  p2.node.set(PDFName.of("StructParents"), ctx.obj(1));
  doc.catalog.set(PDFName.of("StructTreeRoot"), structRoot);
  doc.catalog.set(PDFName.of("MarkInfo"), ctx.obj({ Marked: true }));
  doc.catalog.set(PDFName.of("Lang"), PDFHexString.fromText("cs-CZ"));

  // Bookmarks (the outline) with XYZ destinations at the heading tops.
  addOutline(doc, [
    { title: "1. Úvod", page: p1, top: H - 76 },
    { title: "2. Právní rozbor", page: p1, top: H - (90 + 16.8 + 10 + 3 * GAP + AFTER + 2 * GAP + AFTER + 6 - 14), kids: [{ title: "2.1 Předvídatelnost škody", page: p2, top: H - 78 }] },
    { title: "3. Závěr", page: p2, top: H - 150 },
  ]);
  return doc.save({ useObjectStreams: false });
}

// ─────────────────────────────────────────────────────────────── rejects

/** Two pages with no text layer at all — what a scanner without OCR produces. */
async function scan() {
  const { doc } = await newDoc({ title: "Sken", author: "", producer: "Canon iR-ADV C5535", creator: "Canon iR-ADV C5535" });
  for (let i = 0; i < 2; i++) {
    const page = doc.addPage([595, 842]);
    page.drawRectangle({ x: 60, y: 60, width: 475, height: 722, color: rgb(0.93, 0.93, 0.9) });
  }
  return doc.save({ useObjectStreams: false });
}

/**
 * A document protected by a user password: a Standard security handler
 * whose /U entry cannot match the empty password, so a reader must ask for
 * one (the content itself is never reached, so it is not encrypted here).
 */
async function encrypted() {
  const { doc, regular } = await newDoc({ title: "Chráněno", author: "", producer: "pdf-lib", creator: "pdf-lib" });
  doc.addPage([595, 842]).drawText("Tajný text", { x: 72, y: 700, size: 12, font: regular });
  const ctx = doc.context;
  const hex = (byte, n) => PDFHexString.of(byte.repeat(n));
  ctx.trailerInfo.Encrypt = ctx.register(ctx.obj({ Filter: "Standard", V: 1, R: 2, Length: 40, O: hex("4f", 32), U: hex("55", 32), P: -3904 }));
  ctx.trailerInfo.ID = ctx.obj([hex("ab", 16), hex("ab", 16)]);
  return doc.save({ useObjectStreams: false });
}

/** A (nested) PDF outline — pdf-lib has no API for it. */
function addOutline(doc, entries) {
  const ctx = doc.context;
  const build = (items, parentRef) => {
    const refs = items.map(() => ctx.nextRef());
    items.forEach((item, i) => {
      const dict = {
        Title: PDFHexString.fromText(item.title),
        Parent: parentRef,
        Dest: [item.page.ref, "XYZ", null, item.top, null],
      };
      if (i > 0) dict.Prev = refs[i - 1];
      if (i < items.length - 1) dict.Next = refs[i + 1];
      if (item.kids?.length) {
        const kidRefs = build(item.kids, refs[i]);
        dict.First = kidRefs[0];
        dict.Last = kidRefs[kidRefs.length - 1];
        dict.Count = item.kids.length;
      }
      ctx.assign(refs[i], ctx.obj(dict));
    });
    return refs;
  };
  const root = ctx.nextRef();
  const top = build(entries, root);
  ctx.assign(root, ctx.obj({ Type: "Outlines", First: top[0], Last: top[top.length - 1], Count: entries.length }));
  doc.catalog.set(PDFName.of("Outlines"), root);
}

mkdirSync(OUT, { recursive: true });
for (const [name, make] of [
  ["commentary.pdf", commentary],
  ["journal-2col.pdf", journal],
  ["word-tagged.pdf", word],
  ["scan.pdf", scan],
  ["encrypted.pdf", encrypted],
]) {
  const bytes = await make();
  writeFileSync(path.join(OUT, name), bytes);
  console.log(`${name}: ${bytes.length} B`);
}
