/**
 * Regenerates app/apple-icon.png from public/logo.svg.
 *
 * Apple touch icons must be raster and are masked to a rounded square by iOS
 * itself, so the source is the logo WITHOUT our own corner radius, painted on
 * the sky colour (no transparency — iOS composites it on white otherwise).
 *
 * Run manually after changing the logo: `node scripts/build-icons.mjs`.
 * Uses sharp, which ships with Next.js as an optional dependency; if it is
 * missing, `npm i -D sharp` first. Not wired into the build — the generated
 * PNG is committed.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import sharp from "sharp";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = readFileSync(path.join(root, "public", "logo.svg"), "utf8");
const fullBleed = source.replace('rx="14" ', "");

const png = await sharp(Buffer.from(fullBleed)).resize(180, 180).png({ compressionLevel: 9 }).toBuffer();
writeFileSync(path.join(root, "app", "apple-icon.png"), png);
console.log(`app/apple-icon.png — 180×180, ${png.length} bytes`);
