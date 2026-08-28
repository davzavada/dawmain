#!/usr/bin/env node
/**
 * Downloads real upstream response samples committed in public GitHub repos
 * (the repos referenced by docs/research/*.json). GitHub is reachable from
 * the dev environment even though the court sites themselves are not, so
 * these are the only *real* fixtures available before the first deploy.
 *
 *   node scripts/fetch-fixtures.mjs          # download all into tests/fixtures/
 *
 * After deploying, better fixtures come from the live sources via
 * `dawmain_probe_sources {include_raw: true}` — replace these as they land.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURES = [
  // NALUS — live captures (2026-08-01) of the search form and a results page.
  {
    dir: "nalus",
    file: "search-form.html",
    url: "https://raw.githubusercontent.com/Gamnog/Paperclip---X1/main/pipeline/test/fixtures/nalus/search-form.html",
  },
  {
    dir: "nalus",
    file: "results-page-1.html",
    url: "https://raw.githubusercontent.com/Gamnog/Paperclip---X1/main/pipeline/test/fixtures/nalus/results-page-1.html",
  },
];

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "tests", "fixtures");
let failures = 0;

for (const fixture of FIXTURES) {
  const target = path.join(root, fixture.dir, fixture.file);
  try {
    const response = await fetch(fixture.url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = Buffer.from(await response.arrayBuffer());
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body);
    console.log(`✓ ${fixture.dir}/${fixture.file} (${body.length} bytes)`);
  } catch (error) {
    failures++;
    console.error(`✗ ${fixture.dir}/${fixture.file}: ${error.message}`);
  }
}

process.exit(failures ? 1 : 0);
