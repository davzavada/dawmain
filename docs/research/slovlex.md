# Slov-Lex (slov-lex.sk) — zmapovaná API (živě 17. 11. 2026)

Nový portál www.slov-lex.sk je SPA (module federation). Data tahá z veřejné
brány `https://api-gateway.slov-lex.sk` **bez přihlášení**; plné texty
předpisů leží jako statické HTML na `https://static.slov-lex.sk`. Záchyty
odpovědí jsou v `tests/fixtures/slovlex/`.

Pozor na Spring: chybějící povinný parametr → přesměrování na zabezpečené
`/error` → **401 `WWW-Authenticate: Basic`** (ne 400). U `vseobecne/filter`
proto vždy posílat i prázdné `query=&povahaRozhodnutiaFacetFilter=&ecli=&spisovaZnacka=&cisloSpisu=`.
Špatná metoda / chybějící sort → 404.

## Právne predpisy (Zbierka zákonov SR)

`GET /vyhladavanie/predpisZbierky/rozsirene` (Solr; `predpis-search-*.json`)
- parametry: `text` (fulltext), `nazov`, `cislo` („40/1964“), `rocnik`,
  `typPredp_value` (název typu, např. „Zákon“, „Vyhláška“, „Nariadenie vlády“),
  `ucinnyK` (YYYY-MM-DD — účinné k datu), `vyhlaseny_zaciatok`/`vyhlaseny_koniec`,
  `pravnaOblast[]`, `autor`, `meni[]`, `rusi[]`, `jeMeneny[]`, `jeRuseny[]`
  (číslo/rok „40/1964“), `vykonavaciPredpisKu[]`, `rows`, `start`, `sort`
  (např. „vyhlaseny desc“). Pole jako `pravnaOblast[]=` (qs brackets).
- odpověď: `{numFound,start,docs:[{iri:"/SK/ZZ/1964/40/20260731", cislo:"40/1964 Zb.", nazov, typPredp_value, rocnik, vyhlaseny, ucinnyOd, zodpovedajucaUcinnost, nadpisy[]? }]}`
  (`iri` končí datem znění, které odpovídá dotazu).
- Veřejný odkaz: `https://www.slov-lex.sk/ezbierky/pravne-predpisy/SK/ZZ/1964/40/20260731`
  (bez data = aktuální znění).

Historie znění: `GET https://static.slov-lex.sk/static/SK/ZZ/{rok}/{cislo}/`
(`predpis-history-*.html`) — tabulka „Dátum účinnosti | Novela“ s odkazy
`vyhlasene_znenie.html`, `YYYYMMDD.html` a novelami `../../../ZZ/1969/58/19690701.html`.

Text znění: `GET https://static.slov-lex.sk/static/SK/ZZ/{rok}/{cislo}/{YYYYMMDD}.html`
(`predpis-text-325-2025-20290901.html`); kotvy `id="paragraf-1"`,
`paragraf-1.odsek-2.pismeno-a`, `clanok-I` …; `*.oznacenie` = nadpis §.
Občiansky zákonník má 1,7 MB — vždy číst po §/okně.

## eLegislatíva — legislativní procesy (LP)

- Hledání: `POST /internal/elegislativa/legislativne-materialy/filter?page=1&size=10[&sortBy&sortDirection]`
  tělo JSON (`{}` = vše; ověřená pole: `hladanyVyraz` (fulltext, `lp-filter-text.json`),
  `cisloLegislativnehoMaterialu` („LP/2025/300“), dále z bundlu `nazov`, `rocnik`, `rezortneCislo`,
  `stadium` (kód, např. `ROKOVANIE_NRSR`, `VYHLASENE_V_ZBIERKE`, `MPK`, `PROCES_UKONCENY`),
  `typKod` (`Zakon`, `PredbeznaInfo`…), `oblastKodList[]`, `datumZmenyOd`/`datumZmenyDo` (YYYY-MM-DD)),
  odpověď `{totalElements, legMaterialList:[{uuid, typNazov, cisloLegislativnehoMaterialu:"LP/2026/625", nazov, stadium:{hodnota,nazov}, zaciatokStadia}]}`.
- Detail: `GET /internal/elegislativa/legislativne-materialy/LP/{rok}/{cislo}` (`lp-detail-2025-300.json`):
  typ, oblastList, stadium, rezortneCislo, podnet, zodpovednaInstitucia, zodpovednyPredkladatel,
  hlavnyNovelizovanyPredpis{iri,menovka,popis}, novelizovanePredpisy[], vyhlasenyPodCislomList[] (→ Zbierka),
  datumZaciatkuPkMpk/datumUkonceniaPkMpk, vysledokNrSr, suvisiaceProcesy, uuid.
- Štádiá s daty: `GET /external/evidencna-aplikacia/legislativne-materialy/{uuid}/historia`
  (`lp-historia-2025-300.json`) → `historiaRecords[{uuid, stadium{hodnota,nazov}, datumZacatia, datumUkoncenia, vlastnikAktivity}]`.
- Dokumenty štádia: `GET /external/evidencna-aplikacia/legislativne-materialy/{uuid}/sprievodne-dokumenty?stadiumUuid={historiaRecord.uuid}`
  (`lp-dokumenty-2025-300.json`) → `[{uuid, nazov:"04_vseobecna.docx", velkost, typ{nazov:"Dôvodová správa",kod}}]`.
- Stažení: `GET /external/evidencna-aplikacia/sprievodne-dokumenty/{uuid}/download` → DOCX/PDF (octet-stream).
- Veřejný odkaz: `https://www.slov-lex.sk/elegislativa/legislativne-procesy/SK/LP/2025/300`.
- Podobné vyhledávání LP podle textu: `GET /vyhladavanie/legislativnyMaterial/navrhy?dopyt="…"&rows=` (našeptávač).

## Súdne rozhodnutia

Základ `https://api-gateway.slov-lex.sk/internal/sudne-rozhodnutia`.

Všeobecné súdy SR (≈ 4,7 mil., vč. NS SR `sud_100` a NSS SR `sud_175`):
- `GET /vseobecne/filter` — `query` (fulltext, „…“ = přesná fráze), `spisovaZnacka`, `ecli`, `cisloSpisu`,
  `guidSud`, `guidSudca`, `vydaniaOd`/`vydaniaDo` (YYYY-MM-DD), `typSuduFacetFilter`, `krajFacetFilter`,
  `okresFacetFilter`, `oblastPravnejUpravyFacetFilter`, `podOblastPravnejUpravyFacetFilter`,
  `formaRozhodnutiaFacetFilter`, `povahaRozhodnutiaFacetFilter`, `odkazovanePredpisy`,
  `page` (od 1), `size`, `sortBy` (`datum_vydania_rozhodnutia`|`spisova_znacka`|`sudca_meno`), `sortDirection`.
  Odpověď `{page:{totalElements, rozhodnutieList:[{guid, identifikacneCislo, spisovaZnacka, datumVydania:"16.11.2026", sud, sudca}]}, fazetFilter:{…}}`.
- `GET /vseobecne/{guid}` (`vseobecne-detail.json`): forma, povaha, oblast, ECLI, odkazovanePredpisy[{url,nazov}],
  `dokument{name,url:"https://obcan.justice.sk/content/public/item/<id>"}` → PDF s textem (`vseobecne-doc.pdf`).
- `GET /vseobecne/sud?query=&limit=40`, `/vseobecne/sudca?query=&limit=40` — číselníky soudů a soudců.
- Veřejný odkaz: `https://www.slov-lex.sk/sudne-rozhodnutia/vseobecne-sudy-sr/{guid}`.

Judikáty (Zbierka stanovísk a rozhodnutí, ≈ 2,9 tis.):
- `POST /judikaty/filter?page=1&size=10&sortBy=datumRozhodnutia&sortDirection=DESC`
  tělo `{hladanyVyraz, nazovRozhodnutia, spisovaZnacka, sud, datumRozhodnutiaOd, datumRozhodnutiaDo}`
  (`sud` kód, např. „NSSR“). Odpověď `{totalElements, judikatList:[{uuid, spisovaZnacka, typRozhodnutia{nazov}, nazovRozhodnutia, datumRozhodnutia}]}`.
- `GET /judikaty/{uuid}` (`judikat-detail.json`): sud, oblastPravnejUpravy, ecli, vazbyNaPredpisZbierky,
  `secHtml` (právna veta + odůvodnění v HTML), `sudHtml`.
- Veřejný odkaz: `https://www.slov-lex.sk/sudne-rozhodnutia/judikaty/{uuid}`.

Další sekce (nepoužito): `/eslp/filter`, `/sdeu/filter` (ESĽP a SD EÚ ve slovenštině).

Ústavný súd SR na slov-lex není (vlastní web ustavnysud.sk) — mimo rozsah.
