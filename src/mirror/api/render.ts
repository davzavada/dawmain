import { isSeparatorRule } from "../index";
import type { FullDecision } from "./queries";

/**
 * The whole decision as one HTML page: metadata, právní věta, the text with
 * its pictures at their places (inlined as data: URIs — the page then needs
 * no further authenticated requests) and a rule before every odlišné
 * stanovisko — NALUS's own separator picture (609×1) is drawn as that rule.
 * No formatting beyond paragraphs: the mirror stores none.
 * Metafile pictures (WMF/EMF) browsers cannot show are named, not drawn.
 * Pure — unit-tested.
 */

export interface RenderImage {
  ord: number;
  char_at: number;
  mime: string;
  width: number | null;
  height: number | null;
  bytes: Uint8Array;
}

const escape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function paragraphs(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escape(p).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

function image(img: RenderImage): string {
  if (isSeparatorRule(img)) return '<hr class="dissent">';
  if (img.mime !== "image/png" && img.mime !== "image/jpeg" && img.mime !== "image/gif") {
    return `<p class="img-missing">[obrázek ${img.ord + 1}: ${escape(img.mime)} – prohlížeč ho neumí zobrazit]</p>`;
  }
  const size = img.width && img.height ? ` width="${img.width}" height="${img.height}"` : "";
  return `<p class="img"><img src="data:${img.mime};base64,${Buffer.from(img.bytes).toString("base64")}"${size} alt="obrázek ${img.ord + 1}"></p>`;
}

/**
 * `formatted`: the decision with the court's formatting (./original.ts), shown
 * instead of the plain text when there is one; <main data-format> says which.
 */
export function renderDecisionHtml(d: FullDecision, images: RenderImage[], formatted: string | null = null): string {
  const body = d.body ?? "";
  // Cut points: every picture, and the start of every dissent (NALUS draws a
  // rule there itself: then the picture is the rule, no second one).
  const marks = [
    ...images.map((img) => ({ at: Math.min(img.char_at, body.length), html: image(img) })),
    ...d.dissents
      .filter((x) => !images.some((img) => isSeparatorRule(img) && x.charStart - Math.min(img.char_at, body.length) <= 4 && x.charStart >= img.char_at))
      .map((x) => ({ at: x.charStart, html: '<hr class="dissent">' })),
  ].sort((a, b) => a.at - b.at);
  let html = "";
  let from = 0;
  for (const m of marks) {
    html += paragraphs(body.slice(from, m.at)) + "\n" + m.html + "\n";
    from = m.at;
  }
  html += paragraphs(body.slice(from));

  const meta = [
    d.court,
    d.form,
    d.date ? `rozhodnuto ${d.date}` : null,
    d.published ? `zveřejněno ${d.published}` : null,
    d.ecli,
  ].filter(Boolean);
  return `<!doctype html>
<html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(d.caseNumber ?? d.id)}</title>
<style>
body{font:16px/1.55 Georgia,serif;max-width:46rem;margin:2rem auto;padding:0 1rem;color:#1a1a1a;background:#fff}
header{font-family:system-ui,sans-serif;border-bottom:1px solid #ccc;margin-bottom:1.5rem}
h1{font-size:1.4rem;margin:0 0 .3rem}.meta{color:#555;font-size:.9rem}
.lv{background:#f4f4f0;padding:.8rem 1rem;border-left:3px solid #999}
hr.dissent{border:0;border-top:2px solid #666;margin:2.5rem 0 1rem}
.al-center{text-align:center}.al-right{text-align:right}.al-justify{text-align:justify}
main table{border-collapse:collapse;margin:1rem 0}main td,main th{border:1px solid #ccc;padding:.3rem .5rem;vertical-align:top}
.anon{background:#eee;padding:0 .2em}
.img img{max-width:100%;height:auto}.img-missing{color:#777;font-style:italic}
@media (prefers-color-scheme:dark){body{background:#151515;color:#ddd}.lv{background:#222}.meta{color:#aaa}}
</style></head><body>
<header><h1>${escape(d.caseNumber ?? d.id)}</h1>
<p class="meta">${meta.map((m) => escape(String(m))).join(" · ")} · <a href="${escape(d.url)}">oficiální zdroj</a></p></header>
${d.legalSentence ? `<section class="lv"><strong>Právní věta.</strong> ${escape(d.legalSentence)}</section>\n` : ""}<main data-format="${formatted ? "original" : "text"}">
${formatted ?? (body ? html : "<p><em>Text rozhodnutí zatím není stažený.</em></p>")}
</main></body></html>`;
}
