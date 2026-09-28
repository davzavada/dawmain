/**
 * Types for the vendored Snowball 3.1.1 Czech stemmer (czech-stemmer.js,
 * base-stemmer.js — BSD-3-Clause, see LICENSE-snowball.txt). The two .js
 * files are verbatim copies of snowballstem/snowball-website js/ ("Generated
 * from czech.sbl by Snowball 3.1.1"); never edit them — a changed file must
 * bump ANALYZER_VERSION (src/files/config.ts) so stored indexes are rebuilt,
 * and tests/files-stem.test.ts pins their sha256.
 */
export default class CzechStemmer {
  constructor();
  /** Stem one lowercase word WITH its diacritics (fold afterwards, never before). */
  stemWord(word: string): string;
  setCurrent(value: string): void;
  getCurrent(): string;
  stem(): boolean;
}
