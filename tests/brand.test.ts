import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The brand mark lives in two places by framework convention: app/icon.svg is
 * the favicon (Next.js file convention) and public/logo.svg is the asset the
 * page and README reference. They must never drift apart.
 */
const root = path.dirname(__dirname);
const ICON = path.join(root, "app", "icon.svg");
const LOGO = path.join(root, "public", "logo.svg");

describe("brand assets", () => {
  it("keeps app/icon.svg byte-identical to public/logo.svg", () => {
    expect(readFileSync(ICON, "utf8")).toBe(readFileSync(LOGO, "utf8"));
  });

  it("is a self-contained, scalable SVG", () => {
    const svg = readFileSync(LOGO, "utf8");
    expect(svg).toContain('viewBox="0 0 64 64"');
    // No external references: a favicon fetched cross-origin would not render.
    expect(svg).not.toMatch(/xlink:href|<image|url\(['"]?https?:/);
    // Gradient ids are namespaced so inlining the mark cannot clash with a page.
    for (const id of ["dawmainSky", "dawmainSun", "dawmainGlow", "dawmainCounter"]) {
      expect(svg).toContain(`id="${id}"`);
    }
  });

  it("ships a 180×180 apple touch icon", () => {
    const png = readFileSync(path.join(root, "app", "apple-icon.png"));
    expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
    // IHDR width/height live at bytes 16..24 of every PNG.
    expect(png.readUInt32BE(16)).toBe(180);
    expect(png.readUInt32BE(20)).toBe(180);
  });
});
