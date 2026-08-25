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
  // NS — production ingestion fixture (result rows + detail shapes).
  {
    dir: "ns",
    file: "cz-ns.json",
    url: "https://raw.githubusercontent.com/stella/stella/main/apps/api/scripts/__fixtures__/case-law/cz-ns.json",
  },
  // e-Sbírka — the official OpenAPI definition (copy of DIA's ZIP content).
  {
    dir: "esbirka",
    file: "openapi.json",
    url: "https://raw.githubusercontent.com/kokes/esbirka/main/openapi.json",
  },
  // justice.cz — the ministry's own OpenAPI spec.
  {
    dir: "justice",
    file: "openapi.yaml",
    url: "https://raw.githubusercontent.com/MSPotevrenadata/soudnirozhonduti_api/refs/heads/main/YAML_rozhodnuti.yaml",
  },
];

const root = path.join(import.meta.dirname, "..", "tests", "fixtures");
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
