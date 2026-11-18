import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * What every page loads: the root layout's static import graph. Only the
 * reader of old modal links (app/_zdroje/modals.tsx) mounts in the layout;
 * the Vlastní soubory page (app/soubory) and the Zotero page are routes of
 * their own, and the uploader's processing with the DMD parser, the outline
 * slicer, pdf.js and mammoth stays behind a dynamic import even on the files
 * page, so a visitor of /podminky — or of /soubory who uploads nothing —
 * downloads none of it (review web:Z8, ops:FT-8). Static `import … from`
 * edges are followed; `import()` and next/dynamic are the lazy boundary.
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

const CONVERSION = [
  "app/_zdroje/upload-process.ts",
  "src/files/dmd/parse.ts",
  "src/files/convert/slice.ts",
  "src/files/convert/index.ts",
];

describe("first-load JS of every page (review web:Z8, ops:FT-8)", () => {
  const { files, packages } = graph("app/layout.tsx");
  const loaded = [...files].map(rel);

  it("the layout reaches the old-link reader, not the pages", () => {
    // The walker really walks: the header's account menu and the old-link reader are in every page.
    expect(loaded).toContain("app/_zdroje/store.ts");
    expect(loaded).toContain("app/_zdroje/modals.tsx");
    for (const page of ["app/soubory/files-page.tsx", "app/_zdroje/file-editor.tsx", "app/zotero/zotero-page.tsx", "app/_zdroje/meta-form.ts"]) {
      expect(loaded, page).not.toContain(page);
    }
  });

  it("no uploader, DMD parser, slicer or converter in the layout's graph", () => {
    for (const lazy of ["app/_zdroje/upload.tsx", "app/_zdroje/upload-core.ts", "src/files/dmd/billing.ts", ...CONVERSION]) {
      expect(loaded, lazy).not.toContain(lazy);
    }
    expect(loaded.filter((f) => f.startsWith("src/files/convert/"))).toEqual([]);
    for (const pkg of packages) expect(pkg).not.toMatch(/^(pdfjs-dist|mammoth)/);
  });

  it("the files page loads the upload queue, but the processing only through a dynamic import", () => {
    const page = graph("app/soubory/[[...knihovna]]/page.tsx");
    const onPage = [...page.files].map(rel);
    expect(onPage).toContain("app/soubory/files-page.tsx");
    expect(onPage).toContain("app/_zdroje/upload.tsx");
    for (const lazy of CONVERSION) expect(onPage, lazy).not.toContain(lazy);
    expect(onPage.filter((f) => f.startsWith("src/files/convert/"))).toEqual([]);
    for (const pkg of page.packages) expect(pkg).not.toMatch(/^(pdfjs-dist|mammoth)/);
    // The one way in: import("./upload-process") inside the queue, and nobody else names it.
    const upload = readFileSync(path.join(ROOT, "app/_zdroje/upload.tsx"), "utf8");
    expect(upload).toMatch(/await import\("\.\/upload-process"\)/);
    for (const file of page.files) {
      if (rel(file) === "app/_zdroje/upload.tsx") continue;
      expect(readFileSync(file, "utf8"), rel(file)).not.toContain("upload-process");
    }
    // The processing itself does reach the parser and the converters (so the checks above mean something).
    expect([...graph("app/_zdroje/upload-process.ts").files].map(rel)).toContain("src/files/dmd/parse.ts");
    expect(readFileSync(path.join(ROOT, "app/_zdroje/upload-process.ts"), "utf8")).toMatch(/import\("@\/src\/files\/convert\/index"\)/);
  });
});
