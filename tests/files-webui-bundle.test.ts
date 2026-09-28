import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * What every page loads: the root layout's static import graph. The
 * Vlastní zdroje modals mount in the layout, but their bodies — and above
 * all the uploader with the DMD parser, the outline slicer, pdf.js and
 * mammoth — must stay behind dynamic imports, so a visitor of /podminky
 * downloads none of it (review web:Z8, ops:FT-8; plan §2: conversion code
 * loads only for Vlastní zdroje). Static `import … from` edges are followed;
 * `import()` and next/dynamic are the lazy boundary.
 */

const ROOT = path.resolve(import.meta.dirname, "..");

function resolve(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(ROOT, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(from), spec);
  else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
    if (existsSync(candidate) && /\.(ts|tsx)$/.test(candidate)) return candidate;
  }
  return null;
}

/** Static (non-type) imports of one module: local files and package names. */
function staticImports(file: string): { local: string[]; packages: string[] } {
  const src = readFileSync(file, "utf8");
  const local: string[] = [];
  const packages: string[] = [];
  for (const m of src.matchAll(/^\s*import\s+(type\s+)?([^;]*?)\s+from\s+["']([^"']+)["']/gms)) {
    if (m[1]) continue; // import type — erased
    const spec = m[3];
    const target = resolve(file, spec);
    if (target) local.push(target);
    else if (!spec.startsWith(".") && !spec.startsWith("@/")) packages.push(spec);
  }
  for (const m of src.matchAll(/^\s*import\s+["']([^"']+)["'];/gm)) {
    const target = resolve(file, m[1]);
    if (target) local.push(target);
  }
  return { local, packages };
}

function graph(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const todo = [path.join(ROOT, entry)];
  while (todo.length) {
    const file = todo.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    const { local, packages: p } = staticImports(file);
    p.forEach((x) => packages.add(x));
    todo.push(...local);
  }
  return { files, packages };
}

const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join("/");

describe("first-load JS of every page (review web:Z8, ops:FT-8)", () => {
  const { files, packages } = graph("app/layout.tsx");
  const loaded = [...files].map(rel);

  it("the layout reaches the modal reader, not the modals", () => {
    // The walker really walks: the header's account menu and the nav item are in every page.
    expect(loaded).toContain("app/_zdroje/own-sources.tsx");
    expect(loaded).toContain("app/_zdroje/store.ts");
    expect(loaded).toContain("app/_zdroje/modals.tsx");
    for (const lazy of ["app/_zdroje/sources-modal.tsx", "app/_zdroje/team-modal.tsx", "app/_zdroje/detail.tsx", "app/_zdroje/list.tsx", "app/_zdroje/meta-form.ts"]) {
      expect(loaded, lazy).not.toContain(lazy);
    }
  });

  it("no uploader, DMD parser, slicer or converter in the layout's graph", () => {
    for (const lazy of [
      "app/_zdroje/upload.tsx",
      "app/_zdroje/upload-core.ts",
      "src/files/dmd/parse.ts",
      "src/files/dmd/billing.ts",
      "src/files/convert/slice.ts",
      "src/files/convert/index.ts",
    ]) {
      expect(loaded, lazy).not.toContain(lazy);
    }
    expect(loaded.filter((f) => f.startsWith("src/files/convert/"))).toEqual([]);
    for (const pkg of packages) expect(pkg).not.toMatch(/^(pdfjs-dist|mammoth)/);
  });

  it("inside the modal the uploader is lazy too (only Pro users with upload rights load it)", () => {
    const modal = graph("app/_zdroje/sources-modal.tsx").files;
    const inModal = [...modal].map(rel);
    expect(inModal).not.toContain("app/_zdroje/upload.tsx");
    expect(inModal).not.toContain("src/files/dmd/parse.ts");
    expect(readFileSync(path.join(ROOT, "app/_zdroje/sources-modal.tsx"), "utf8")).toMatch(/dynamic\(\(\) => import\("\.\/upload"\)/);
  });
});
