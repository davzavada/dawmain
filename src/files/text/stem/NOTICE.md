# Vendored: Snowball Czech stemmer

- `czech-stemmer.js`, `base-stemmer.js` — verbatim from
  https://github.com/snowballstem/snowball-website/tree/main/js
  ("Generated from czech.sbl by Snowball 3.1.1", fetched 2026-09-27).
  sha256: czech-stemmer.js `55c7f42589587ac7ac5bcf4db748435d68166e99eed9c7ceaa965e988be8276f`,
  base-stemmer.js `bf6f03e1a0d29d9e6e669a3a13069187e4095a8c67251e475f5b6b2102974e26`.
- License: BSD-3-Clause, `LICENSE-snowball.txt` (Snowball COPYING).
- Do not edit. Replacing them changes every stored stem: bump `ANALYZER_VERSION`
  in `src/files/config.ts` and re-derive the indexes (operator page).

The folded suffix list used for query words typed without diacritics
(`src/files/text/analyze.ts`) is adapted from Apache Lucene's `CzechStemmer`
(Dolamic & Savoy light stemmer), Apache-2.0 — see the header there.
