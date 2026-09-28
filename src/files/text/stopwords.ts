/**
 * Czech stopwords for the QUERY side of Vlastní zdroje search. The index
 * keeps every word (phrase positions must stay intact); a query drops these
 * so "náhrada škody podle smlouvy" does not require "podle" in the chunk.
 *
 * The list is Apache Lucene's Czech stopword list
 * (lucene/analysis/common/src/resources/org/apache/lucene/analysis/cz/stopwords.txt),
 * 172 lines, one duplicate ("ji"). Licensed under the Apache License,
 * Version 2.0 (http://www.apache.org/licenses/LICENSE-2.0); copyright the
 * Apache Software Foundation. Reproduced verbatim below; the only changes are
 * applied in code: folding (diacritics dropped, so "jí"/"ji" and "mě"/"me"
 * merge) and the LEGAL_TERMS exceptions.
 *
 * Pure — unit-tested (tests/files-analyze.test.ts).
 */

/** Lucene's list, verbatim and in its original order. */
export const LUCENE_CZECH_STOPWORDS: readonly string[] = `
a s k o i u v z dnes cz tímto budeš budem byli jseš můj svým ta tomto tohle tuto tyto jej zda
proč máte tato kam tohoto kdo kteří mi nám tom tomuto mít nic proto kterou byla toho protože
asi ho naši napište re což tím takže svých její svými jste aj tu tedy teto bylo kde ke
pravé ji nad nejsou či pod téma mezi přes ty pak vám ani když však neg jsem tento článku
články aby jsme před pta jejich byl ještě až bez také pouze první vaše která nás nový
tipy pokud může strana jeho své jiné zprávy nové není vás jen podle zde už být více bude
již než který by které co nebo ten tak má při od po jsou jak další ale si se ve to jako za
zpět ze do pro je na atd atp jakmile přičemž já on ona ono oni ony my vy jí ji mě mne jemu
tomu těm těmu němu němuž jehož jíž jelikož jež jakož načež
`
  .trim()
  .split(/\s+/);

/**
 * Words Lucene lists (it was built from web news text) that are terms of art
 * in legal writing and must stay searchable: "smluvní strana", "článku 6
 * Úmluvy", "důvodová zpráva".
 */
export const LEGAL_TERMS: ReadonlySet<string> = new Set(["strana", "clanku", "clanky", "zpravy"]);

function fold(word: string): string {
  return word.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Folded stopwords, minus LEGAL_TERMS — compare against foldWord(token). */
export const STOPWORDS: ReadonlySet<string> = new Set(
  LUCENE_CZECH_STOPWORDS.map(fold).filter((w) => !LEGAL_TERMS.has(w)),
);
