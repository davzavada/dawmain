# Plán: slovenské zdroje (Slov-Lex) v Dawmainu

Pracovní plán implementace (návrh 17. 11. 2026). API popisuje
[slovlex.md](slovlex.md), záchyty jsou v `tests/fixtures/slovlex/`.

## Zjištění, která určují návrh

- **Pozor na novelizující předpis v jediném textovém záchytu.** `predpis-text-325-2025-20290901.html` je novela. Její vlastní ustanovení jsou `div.clanok#predpis.clanok-1…5` (označení `Čl. I`, id arabsky). `id="paragraf-30"`, `paragraf-42a` … leží uvnitř `div.citat` = citované nové znění, ne paragrafy tohoto předpisu. Hledání jen podle `#paragraf-N` vrátí špatný text.
- **Chybí záchyt kmenového předpisu** — balík A ho zachytí (malý zákon) a ověří značkování (`paragraf-1`, `paragraf-1.odsek-2.pismeno-a`, `clanok-I`).
- **Tabulka znění je v HTML**: stránka historie i každá stránka textu nese `tr.effectivenessHistoryItem` s `data-iri`, `data-vyhlasene`, `data-ucinnostod`, `data-ucinnostdo` a novelami ve třetí buňce (`58/1969&nbsp;Zb.`). OZ má 69 řádků; poslední končí `2027-06-30` bez následníka.
- **Výsledky hledání nemají zvýraznění**, jen `numFound`, `start`, `docs`; `nadpisy[]` (OZ 132) je nutné zkrátit.
- **Dokumenty LP jsou nejspíš kumulativní** (poslední štádium vrací 19 souborů vč. MPK) — B ověří živě.
- **`typ.kod` dokumentu LP**: `DovodovaSprava` (všeobecná i osobitná), `VlastnyMaterial`, `PredkladaciaSprava`, `DolozkaVplyvov`, `TabulkaZhody`, `SchvaleneZnenieZakonaVNRSR` …
- **Id rozhodnutí všeobecného súdu je `uuid:uuid`**, judikát má prosté uuid. PDF leží na `obcan.justice.sk`.
- **Převodníky DOCX/PDF jsou privátní v `src/sources/psp.ts`** (`defaultConverters`, `activeConverters`, ř. ~737–818) → P0 je vytáhne.
- **Kontrola skenu PDF** (`STOPWORDS` v `src/files/convert/pdf/text.ts`) už obsahuje slovenská slova.
- **Testy, které hlídají seznam nástrojů** (balík D): `tests/skill.test.ts` (regex prefixů; každý `param:` v backticku musí existovat), `tests/guide-hint.test.ts:29` (seznam `*_search`), `tests/source-status.test.ts` (markery canary), `scripts/smoke.mjs` `EXPECTED_TOOLS`.
- **Manuál**: `SKILL.md` má 59,8 kB z `SKILL_MAX_CHARS = 80_000` → slovenská část do ~4k znaků.

## 1. Nástroje (8)

Všechny `READ_ONLY`, `toolFailure(SOURCE)`, text + `structuredContent` jako ostatní.

### Předpisy (jako `esbirka_*`)

Identita: `year` (int 1918–2100), `number` (int ≥ 1); sbírka vždy `ZZ`.

**`sk_predpis_search`** — fulltext, název nebo číslo ve Zbierke zákonov SR. Najde předpisy, ne paragrafy.
- vstup: `query?`→`text`, `title?`→`nazov`, `number?` („40/1964“)→`cislo`, `year?`→`rocnik`, `type?` („Zákon“, „Vyhláška“, „Nariadenie vlády“)→`typPredp_value`, `in_force_on?` (isoDate)→`ucinnyK`, `published_from?`/`published_to?`→`vyhlaseny_zaciatok`/`vyhlaseny_koniec`, `sort` enum `["relevance","newest"]` (default relevance; newest→`vyhlaseny desc`), `limit` 1–25 (10), `offset` (0) → `rows`/`start`.
- aspoň jedno kritérium (`INPUT_INVALID`); `assertDateRange(…, "published")`.
- výstup: `total, count, offset, has_more, items[{citation, year, number, title, type, published, version_from, version_to?, iri, url}]`.
- řádek hitu: `1. 40/1964 Zb. — Občiansky zákonník [Zákon] · znenie od 2026-07-31` + až 3 `nadpisy` obsahující termíny dotazu (fold diakritiky), pak URL `https://www.slov-lex.sk/ezbierky/pravne-predpisy{iri}`. Stránka za koncem jako `esbirka_search`.

**`sk_predpis_get_act`** — citace, název, historie znění.
- vstup: identita + `date?`. Čte `static/SK/ZZ/{year}/{number}/`; název a typ best-effort z hledání `cislo=`.
- výstup: `citation, title?, type?, published?, url, versions[{from?, to?, announced, iri, amended_by[]}]`, nejnovější první, v textu max 30 (jako `esbirka_get_act`); vyznačit znění účinné k `date` (nebo dnes), budoucí označit.

**`sk_predpis_get_text`** — jeden §, jeden čl., nebo celý předpis po stránkách.
- vstup: identita + `date?` (bez = dnes; `"0000-00-00"` = `vyhlasene_znenie`, jako e-Sbírka) + `section?` + `page` (1).
- výstup jako `esbirka_get_text`: `iri, url, section?, version_from?, version_to?, version_type?, future_versions?, page, total_pages, has_more, text`.
- řezání: (1) znění z řádků historie čistou `pickVersion(versions, date)` (cache); (2) stáhnout `{YYYYMMDD}.html` jednou, cheerio (`loadHtml`) → plochý `ActUnit[]`, cachovat rozparsovaný model, ne HTML; (3) jednotka = `div.paragraf`/`div.clanok` bez předka `.citat`, plus strukturní nadpisy a poznámky; (4) shoda podle textu označení (`*Oznacenie`, bez `„`) nebo přípony id, takže `čl. 1` i `čl. I` trefí; nikdy jen `#paragraf-N`; (5) použít `parseSectionLabel` a `chunkFragments` ze `src/sources/esbirka.ts` a `charPage` + `rangeContinuationHint` přesně jako `src/mcp/tools/esbirka.ts`.
- § jen uvnitř `.citat` → `NOT_FOUND` s nápovědou: novela, § je citované nové znění v Čl. X, čti novelizovaný předpis.
- hlavička: `/SK/ZZ/1964/40/20260731 § 123 — účinné 2026-07-31 – 2027-06-30`, ⚠ u znění s `from` po dnešku.

### Legislativní proces (jako `psp_*`)

**`sk_lp_search`**
- vstup: `query?` (`hladanyVyraz`), `number?` („LP/2025/300“ nebo „2025/300“ → rovnou detail/`cisloLegislativnehoMaterialu`), `act?` („325/2025“), `stage?` (enum `stadium.hodnota`), `limit` 1–25 (10), `page` ≥ 1 (upstream 1-based).
- výstup: `total, count, page, has_more, items[{lp, year, number, uuid, type, title, stage, stage_from, url}]`.
- `act` a `stage` jen pokud je filtr podporuje (ověřit živě); `act` lze případně realizovat přes `hladanyVyraz` s číslem.

**`sk_lp_get_process`** (obdoba `psp_get_tisk`)
- vstup: `year`, `number`, `stage?` (index štádia pro soubory dřívějšího štádia).
- volá detail → `/historia` → `sprievodne-dokumenty` posledního štádia.
- text: název, číslo LP, typ, štádium; predkladateľ, inštitúcia, rezortné číslo, podnet; data MPK, `vysledokNrSr`; novelizované předpisy; „Vyhlásené ako 325/2025 Z. z. → `sk_predpis_get_text {year: 2025, number: 325}`“; časová osa štádií s daty; soubory jako `n. [Dôvodová správa] 04_vseobecna.docx (25 kB) → sk_lp_get_text {document_id: "…"}`.
- výstup: `lp, uuid, title, url, stage, stages[], documents[{document_id, name, kind, kind_code, size}], published_as[]`.

**`sk_lp_get_text`** (obdoba `psp_get_text`)
- vstup: `document_id?` (uuid), nebo `year` + `number`; `pdf_pages?` (stejný regex; `parsePdfPages` z `src/mcp/tools/psp.ts`); `find?`; `page`.
- s `year`+`number` čte soubory `DovodovaSprava` posledního štádia spojené pod hlavičkou za soubor a vypíše ostatní soubory s id.
- stažení `/external/evidencna-aplikacia/sprievodne-dokumenty/{uuid}/download` → `extractDocument` (P0) → `pageOrExcerpt` + `continuationHint`.
- výstup jako `psp_get_text`: `url, format, page, total_pages, has_more, matches?, pdf?, documents?, text`.

### Judikatura (jako `justice_*`; bez variant a `read_top`)

**`sk_judikatura_search`**
- vstup: `database` enum `["sudy","judikaty"]` (default `sudy`; sudy = ~4,7 mil. rozhodnutí všech všeobecných súdov vč. NS SR a NSS SR; judikaty = Zbierka stanovísk a rozhodnutí ~2,9 tis. s právnou vetou); `query?` (uvozovky = fráze); `case_number?`→`spisovaZnacka`; `ecli?`; `court?`: `"ns"`→`sud_100`, `"nss"`→`sud_175`, holé `sud_NNN`, nebo název přes `/vseobecne/sud?query=&limit=40` (cache), u judikaty `ns`→`"NSSR"`; `date_from?`/`date_to?`→`vydaniaOd`/`vydaniaDo` resp. `datumRozhodnutiaOd`/`Do`; `form?`, `nature?`, `area?` (`z.enum` ze seznamů `fazetFilter` v `vseobecne-filter-text.json`); `applies_act?` („40/1964“), `applies_section?` → `odkazovanePredpisy`; `limit` 1–50 (20), `page` ≥ 1.
- řazení vždy podle data, nejnovější první. Filtry jen pro sudy + `judikaty` → `INPUT_INVALID`.
- výstup: `total, count, page, total_pages, has_more, items[{id, case_number, court, judge?, type?, title?, decided (ISO přes czechToIso), url}]`; hit jmenuje navazující volání; „More: page: N+1“ a stránka za koncem jako `justiceSearchText`.

**`sk_judikatura_get_decision`**
- vstup: `id`, `find?`, `page`, `pdf_pages?`. `uuid:uuid` = všeobecný súd, prosté uuid = judikát.
- všeobecný súd: detail → hlavička (sp. zn., súd, sudca, forma, povaha, oblasť, ECLI, dátum, odkazované predpisy); `dokument.url` stáhnout z `obcan.justice.sk` a převést `extractDocument`; chybějící soubor / sken / šifrované PDF → `SourceError` s odkazem.
- judikát: `secHtml` (právna veta + odůvodnění) a `sudHtml` přes `htmlToText`, bez úvodního `﻿`.
- pak `pageOrExcerpt(text, page, find)` + `continuationHint`; popis končí `READING_DESCRIPTION`, `find` používá `FIND_DESCRIPTION`.
- citovaná URL: `https://www.slov-lex.sk/sudne-rozhodnutia/vseobecne-sudy-sr/{guid}` nebo `…/judikaty/{uuid}`.

`caselaw_search` a `MIRROR_TOOLS` zůstávají jen české.

## 2. Soubory

### P0 — předpoklad (před A/B/C)

- nový `src/sources/shared/documents.ts`: přesunout z `psp.ts` `DocumentFormat`, `sniffDocument`, `PdfRange`, `PdfOutcome`, `DocumentConverters`, `PDF_MAX_TOTAL_PAGES`, `PDF_PAGES_PER_CALL`, `ExtractedDocument`, `setDocumentConverters` a výchozí převodníky (dynamický `import("@/src/zotero/pdf-text")` a `mammoth`). Přidat
  `extractDocument(source: string, file: { bytes: ArrayBuffer; url: string }, pdfRange?: [number, number], opts?: { label?: string; converters?: DocumentConverters }): Promise<ExtractedDocument>` s přepínačem formátu z `getPspDocument`; `.doc`/RTF → stejná chyba „otevři si sám“.
- `src/sources/psp.ts`: re-exportovat ta jména (`tests/psp.test.ts` beze změny) a `getPspDocument` volá `extractDocument` po vlastním retry `.doc` → `&pdf=1`.
- nový `src/sources/slovlex-base.ts`: `SLOVLEX_GATEWAY = "https://api-gateway.slov-lex.sk"`, `SLOVLEX_STATIC = "https://static.slov-lex.sk/static"`, `SLOVLEX_WEB = "https://www.slov-lex.sk"`; tři SOURCE konstanty (viz kontrakt); `slovlexJson<T>(source, url, init?: { method?: "POST"; body?: unknown })` přes `fetchUpstream` s `accept: application/json` — 404 → `NOT_FOUND`, 401 → `PARSE_DRIFT` („Slov-Lex odpovídá 401, když chybí povinný parametr: tvar požadavku se rozešel“), jiné ne-2xx → `UPSTREAM_ERROR`; `actIri(year, number, version?)`, `parseActCitation("40/1964 Zb." | "/SK/ZZ/1964/40")`, `todayIso()` (Europe/Prague).

### A — předpisy
- `src/sources/slovlex-predpisy.ts`: `buildPredpisSearchUrl`, `parsePredpisSearch`, `searchPredpisy`, `parseHistory`, `pickVersion`, `getVersions`, `parseActText` → `ParsedAct`, `findUnit`, `getActUnits`.
- `src/mcp/tools/sk-predpisy.ts`: `registerSkPredpisy`.
- `tests/slovlex-predpisy.test.ts` + jeden záchyt kmenového předpisu.

### B — legislativní proces
- `src/sources/slovlex-lp.ts`: `buildLpFilterRequest`, `parseLpSearch`, `searchLp`, `getLp`, `getLpHistory`, `getLpDocuments`, `getLpDocumentText`, `LP_DOC_KINDS`.
- `src/mcp/tools/sk-lp.ts`: `registerSkLp`, čisté `skLpSearchText`, `skLpProcessText`.
- `tests/slovlex-lp.test.ts`.

### C — judikatura
- `src/sources/slovlex-judikatura.ts`: `SK_COURT_ALIASES`, `SK_DECISION_FORMS`, `SK_DECISION_NATURES`, `SK_LAW_AREAS`, `buildVseobecneFilterUrl`, `buildJudikatyFilterRequest`, `parseVseobecneSearch`, `parseJudikatySearch`, `resolveCourt`, `searchSkDecisions`, `parseDecisionId`, `getSkDecision`.
- `src/mcp/tools/sk-judikatura.ts`: `registerSkJudikatura`, čisté `skJudikaturaSearchText`, `skDecisionHeader`.
- `tests/slovlex-judikatura.test.ts`.

### D — integrace (jediný balík, který sahá do existujících souborů)
- `src/mcp/tools/index.ts`: tři registrátory za `registerPsp`.
- `src/mcp/tools/probe.ts`: canary a `ALLOWED_FETCH_HOSTS`.
- `src/mcp/databases.ts`, `src/mcp/server.ts`, `skills/dawmain-reserse/SKILL.md`.
- `app/_source-status.tsx`, `app/globals.css`, nový `public/flag-sk.svg`, `app/_header.tsx`, `app/layout.tsx`.
- `docs/development.md`, `README.md`, `scripts/smoke.mjs`.
- testy: `tests/skill.test.ts`, `tests/guide-hint.test.ts`, `tests/source-status.test.ts`, nový `tests/slovlex-integration.test.ts`.

## 3. Instrukce, manuál, stav, probe, dokumentace

**`buildInstructions` (`src/mcp/server.ts`)**: první řádek „Czech, Slovak & EU legal research server…“ (zachovat „Vlastní soubory“ — hlídá `tests/files-tools.test.ts`); USE IT + slovenské právo („slovenské právo“, „Z. z.“, „Zbierka zákonov“, „NS SR“); INTAKE „CZ / SK / EU“; tři odrážky TOOLS za psp: předpisy SR `sk_predpis_search → sk_predpis_get_act → sk_predpis_get_text`; legislativní proces SR `sk_lp_search → sk_lp_get_process → sk_lp_get_text` (dôvodová správa, MPK); judikatura SR `sk_judikatura_search` (`database` sudy|judikaty) `→ sk_judikatura_get_decision`; věta: `sk_*` jen když otázka míří na slovenské právo nebo uživatel chce srovnání CZ/SK, nikdy jako výchozí dráha české rešerše; READING + `sk_predpis_get_text section`; OUTPUT 3: „§ 420 zákona č. 40/1964 Zb.“ / „Z. z.“; Not covered + Ústavný súd SR (ustavnysud.sk).

**`SKILL.md`**: řádek v tabulce `## Tools`; nová sekce `## Slovensko (slov-lex.sk)` před `## Doktrína`, max ~4k znaků: tabulka „Chci | Volání“ pro 8 nástrojů a pět pravidel (dotaz slovenskými termíny; sémantika `date` a ⚠ budoucí znění; novela se čte po `čl.`; `judikaty` (vybrané, právna veta) vs `sudy` (vše, podle data); ÚS SR není pokryt). Jen jména parametrů z oddílu 1.

**`src/mcp/databases.ts`**: `DATABASE_GROUPS = ["Judikatura", "Předpisy", "Slovensko"]`; tři řádky skupiny `Slovensko`: Zbierka zákonov SR `https://www.slov-lex.sk/ezbierky` `slovlex-zbierka`; eLegislatíva `https://www.slov-lex.sk/elegislativa` `slovlex-lp`; Súdne rozhodnutia SR `https://www.slov-lex.sk/sudne-rozhodnutia` `slovlex-sudy`. `source` = příslušná SOURCE konstanta.

**`src/mcp/tools/probe.ts`**: canary připojit před zotero (prefix „valid ids: esbirka-api, …“ v `tests/probe-sources.test.ts` musí zůstat): `slovlex-zbierka` GET `buildPredpisSearchUrl({ number: "40/1964" }, 0, 1)` marker `/"numFound"/`; `slovlex-static` (není v DATABASES) GET `…/static/SK/ZZ/1964/40/` marker `/effectivenessHistoryItem/`; `slovlex-lp` POST `…/legislativne-materialy/filter?page=1&size=1` `{}` marker `/"legMaterialList"/`; `slovlex-sudy` GET `buildVseobecneFilterUrl({ court: "sud_100" }, 1, 1)` marker `/"rozhodnutieList"/`. `ALLOWED_FETCH_HOSTS` + `api-gateway.slov-lex.sk`, `static.slov-lex.sk`, `www.slov-lex.sk`, `obcan.justice.sk`.

**Dokumentace**: `docs/development.md` 8 řádků tabulky nástrojů + krátká poznámka „Slovensko (`sk_*`, 2026-11)“ (Spring 401, statické HTML, P0, co ověřeno živě); `README.md` slovenský odstavec za EUR-Lex; `scripts/smoke.mjs` 8 jmen v `EXPECTED_TOOLS`.

## 4. Web

Třetí skupinu vykreslí `SourceList` sám (iteruje `DATABASE_GROUPS`). Vlajka: statický `public/flag-sk.svg` (bílá, modrá, červená + štít), ne emoji. V `app/_source-status.tsx` `GROUP_FLAG: Partial<Record<DatabaseGroup, string>> = { Slovensko: "/flag-sk.svg" }`, `<img className="source-group-flag" src=… alt="" width={18} height={12} />` před `<h3>` v `.source-group-head`; `LOOK` záznamy `slovlex-zbierka` (list, green), `slovlex-lp` (list, soft), `slovlex-sudy` (court, indigo). `app/globals.css`: `.source-group-flag { border-radius: 2px; box-shadow: 0 0 0 1px var(--line); }`. Volitelně podtitul v `app/_header.tsx` → „české, slovenské a unijní právo“ a `description` v `app/layout.tsx`.

## 5. Testy

Záchyty + `vi.stubGlobal("fetch")`, handlery nástrojů zachycené jako v `tests/psp.test.ts`.

- **A**: `parsePredpisSearch` na čtyřech záchytech (zkrácené `nadpisy`); `buildPredpisSearchUrl` jen neprázdné parametry + rows/start/sort; `parseHistory` 69 řádků 40/1964, vyhlásené znenie, `58/1969 Zb.` s nbsp, dvě novely v řádku, otevřený poslední řádek 325/2025; `pickVersion` 2026-11-17 → `20260731`, 1970-01-01 → `19690701`, `0000-00-00` → vyhlásené, budoucí 325/2025 2028-01-01 a 2029-09-01; `parseActText` 325/2025: Čl. I–V, `čl. I` i `čl. 1` trefí a obsahují citovaný § 30, `§ 30` → `NOT_FOUND` s nápovědou novely; kmenový předpis: `§ N` vrátí nadpis a odseky; nástroj: hlavička znění, ⚠, `rangeContinuationHint` s přeneseným `date`, druhé volání z cache (počet fetch), statická 404 → `NOT_FOUND`.
- **B**: parsery `lp-filter-empty`, `lp-detail`, `lp-historia`, `lp-dokumenty` (19 souborů, druhy); `skLpProcessText` (osa, „Vyhlásené ako 325/2025“, volání dokumentů); `sk_lp_get_text` na `lp-doc-predkladacia.docx` přes skutečný mammoth (jako `tests/files-convert-docx.test.ts`); PDF s injektovanými převodníky; 401 → drift; chybějící id → `INPUT_INVALID`.
- **C**: `buildVseobecneFilterUrl` vždy nese `query=&povahaRozhodnutiaFacetFilter=&ecli=&spisovaZnacka=&cisloSpisu=` a `sortBy`+`sortDirection`; oba parsery hledání (`16.11.2026` → ISO); `parseDecisionId`; detail judikátu (bez BOM, právna veta); hlavička z `vseobecne-detail.json`; `get_decision` se stubem a injektovaným PDF převodníkem, `find` a stránkování; jeden skutečný převod `vseobecne-doc.pdf` přes `pdfText` (vzor `tests/zotero-pdf.test.ts`), ne `unavailable`; stránka za koncem, nula výsledků, `judikaty` + filtr jen pro sudy → `INPUT_INVALID`.
- **D**: `tests/skill.test.ts` + `sk` do regexu prefixů; `tests/guide-hint.test.ts` + tři search nástroje; `tests/source-status.test.ts` nové markery; nový `tests/slovlex-integration.test.ts` (8 jmen registrováno; každý řádek `Slovensko` má `source` = SOURCE a canary; instrukce obsahují tři odrážky `sk_`).
- P0: `tests/psp.test.ts` projde beze změny.

## 6. Kontrakt mezi balíky

| | A | B | C |
|---|---|---|---|
| zdrojový modul | `@/src/sources/slovlex-predpisy` | `@/src/sources/slovlex-lp` | `@/src/sources/slovlex-judikatura` |
| modul nástrojů, registrátor | `./sk-predpisy`, `registerSkPredpisy` | `./sk-lp`, `registerSkLp` | `./sk-judikatura`, `registerSkJudikatura` |
| SOURCE (v `slovlex-base.ts`) | `SLOVLEX_ZBIERKA = "Slov-Lex (Zbierka zákonov SR)"` | `SLOVLEX_LP = "Slov-Lex (eLegislatíva)"` | `SLOVLEX_SUDY = "Slov-Lex (súdne rozhodnutia)"` |
| export pro probe | `buildPredpisSearchUrl(input, start, rows): string` | — | `buildVseobecneFilterUrl(input, page, size): string` |
| nástroje | `sk_predpis_search`, `sk_predpis_get_act`, `sk_predpis_get_text` | `sk_lp_search`, `sk_lp_get_process`, `sk_lp_get_text` | `sk_judikatura_search`, `sk_judikatura_get_decision` |

Jména parametrů z oddílu 1 jsou zmrazená (SKILL.md se proti nim testuje). Když živá kontrola nějaký parametr vyřadí (`act`/`stage` u `sk_lp_search`, `applies_*` u `sk_judikatura_search`), balík to nahlásí.

## Úskalí

- **Spring 401**: chybějící povinný parametr → `/error` → `401 Basic`, ne 400 → drift, nikdy „nedostupné“. Špatná metoda / chybějící sort → 404, takže na filtrech ne každá 404 = „nenalezeno“.
- **Solr pole s hranatými závorkami** (`pravnaOblast[]=`): `URLSearchParams` je kóduje `%5B%5D`; ve v1 nepotřeba.
- **Velké předpisy** (OZ 1,7 MB): `timeoutMs: 25_000`, parsovat jednou, cachovat jednotky (`TtlCache(DOCUMENT_TTL_MS, 6)`), nikdy celý předpis bez stránkování.
- **Cache**: `SEARCH_TTL_MS` pro hledání a číselník soudů; `DOCUMENT_TTL_MS` pro historii, detaily a převedené soubory (6–24 položek); `cache.through()`.
- **Rozpočty**: `sk_lp_get_process` a `sk_judikatura_get_decision` řetězí požadavky → `callDeadline(30_000)`.
- **POST hledání**: `fetchUpstream` je ve výchozím stavu neopakuje; u obou filtrových POST `retry: true` (idempotentní).
- **`recordSourceResult`** podle SOURCE; PDF z `obcan.justice.sk` hlásit pod `SLOVLEX_SUDY`.
- **Kódování** všude UTF-8; normalizovat `&nbsp;` v citacích, odstranit `﻿` z HTML judikátů.
