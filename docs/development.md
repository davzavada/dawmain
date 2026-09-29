# Vývojová dokumentace

Technické zázemí serveru Dawmain — nástroje, architektura, vývoj a nasazení.
Uživatelský popis je v [README](../README.md).

## Nástroje

| Nástroj | Zdroj | Co dělá |
| --- | --- | --- |
| `esbirka_search` | e-Sbírka | fulltext v Sbírce zákonů — vždy přes rozšířené vyhledávání (`all_words` = opravdu všechna slova; jednoduché vyhledávání bralo kterékoli slovo) |
| `esbirka_get_act` | e-Sbírka | metadata a historie znění předpisu |
| `esbirka_get_text` | e-Sbírka | konsolidovaný text k datu — jeden §, jeden článek (`čl. 36`, `čl. I`), nebo celý předpis po ~45k znacích; verze se nejdřív určí přes REST detail (bez data = účinná dnes), odpověď nese „účinné od–do“ a upozornění na zveřejněné budoucí znění |
| `ns_search` / `ns_get_decision` | rozhodnuti.nsoud.cz | judikatura NS: fulltext řazený podle relevance (holá slova spojena AND, fráze jen v uvozovkách, Domino operátory AND/OR/NOT, `nájem*`, NEAR/SENTENCE/PARAGRAPH), přesná sp. zn. (`[spzn1]`–`[spzn4]`), typ rozhodnutí, kategorie A–E, datum rozhodnutí i datum předání na web; hit nese soud a kategorii |
| `nss_search` / `nss_get_decision` | vyhledavac.nssoud.cz | judikatura NSS i krajských správních soudů: fulltext, sp. zn., aplikovaný předpis a ustanovení (`applies_act`/`applies_treaty`/`applies_eu_regulation`/`applies_eu_directive` + `applies_provision`), soud/senát vč. rozšířeného, rejstřík, oblast úpravy, datum rozhodnutí i zpřístupnění — vše server-side dle zachyceného POSTu formuláře (číselníky se řeší za běhu z `ciselnikTreeData`) |
| `us_search` / `us_get_decision` | nalus.usoud.cz | judikatura ÚS: fulltext (vč. zóny disentů a řazení dle významu), citace/ECLI, soudce zpravodaj i disentující, výrok, navrhovatel, napadený akt (druh/číslo/název/ust. — abstraktní přezkum bez klíčových slov), dotčený orgán, jen publikovaná, datum rozhodnutí i zpřístupnění — číselníky verbatim ze zachyceného POSTu formuláře |
| `caselaw_search` | NSS + NS + ÚS | jeden dotaz paralelně přes tři vrcholné soudy; varianty round-robin s počty za variantu, každá varianta s vlastním limitem (pomalá shodí jen sebe); dráha NSS jen NSS (krajské soudy přes `include_regional`), ÚS podle relevance, hit nese soud |
| `justice_search` / `justice_get_decision` | rozhodnuti.justice.cz | obecné soudy (okresní/krajské/vrchní): fulltext (`match` všechna slova/jedno ze slov/fráze), spisová značka, kódy soudů, druh rozhodnutí, datum vydání i zveřejnění, aplikovaný předpis a § (`applies_act` + `applies_section`) — vše server-side přes `/api/finaldoc`, backend SPA zachycený z živého požadavku; hit nese i `affects` (co rozhodnutí udělalo s rozhodnutím nižšího soudu: CHANGE/CONFIRM/CANCEL…) |
| `sdeu_search` / `sdeu_get_document` | InfoCuria + Cellar | FULLTEXT judikatury SDEU (C i T) přes vlastní index soudu — hledá napříč všemi jazykovými verzemi; typ dokumentu, stav věci, citovaný předpis a článek (`cites_celex`/`cites_article`), předběžné otázky podle předkládajícího státu (`referred_from`), datumy — vše server-side dle zachyceného payloadu SPA | 
| `eurlex_search` / `eurlex_get_document` | Cellar SPARQL (Publications Office) | EU legislativa, judikatura i legislativní materiály (návrhy COM, sdělení, zelené/bílé knihy, SWD, impact assessmenty, stanoviska EHSV/VR, postoje EP a Rady) dle názvů, CELEX/ECLI, typů a dat; texty z oficiálního Cellaru |
| `eurlex_get_history` | Cellar SPARQL (Publications Office) | travaux préparatoires aktu z dossieru interinstitucionálního postupu (`cdm:dossier_contains_work` — obsahuje i přijatý akt, takže kotví CELEX aktu i kteréhokoli dokumentu postupu, případně číslo postupu `2012/0011(COD)`); vrací návrh s důvodovou zprávou, impact assessmenty, stanoviska, postoje EP/Rady + číslo postupu, právní základ a stav (přijato/projednáváno/staženo) |
| `doctrine_search` | cuni.primo.exlibrisgroup.com | doktrína: knihy, kapitoly a články z UKAŽ Univerzity Karlovy (Primo VE: katalog UK + Central Discovery Index licencovaných e-zdrojů); `query`/`queries` (≤ 3 varianty), `title`, `author`, `subject`, `language`, `year_from`/`year_to`; katalog stránkuje po 10, `limit` (≤ 20; nad 10 záznamy stručně, bez abstraktů) stáhne víc stránek v paralelní dávce a `page` kráčí dál (`total` = `total_local` + `total_central`) — vrací bibliografické záznamy s odkazem na záznam, abstraktem/obsahem a přístupovými odkazy, žádné plné texty; klient postavený na zachyceném požadavku SPA (HAR 2026-09), ověřený živě z produkce |
| `doctrine_get_record` | cuni.primo.exlibrisgroup.com | jeden záznam v plném znění přes full-display endpoint Prima (ověřený živě): celý abstrakt, obsah (TOC), hesla, identifikátory a přístupové odkazy — hledání ukazuje jen začátek abstraktu a obsahu; text díla se nestahuje (k němu vede odkaz na záznam, licencované tituly si čtenář otevře sám přes vzdálený přístup UK) |
| `files_search` | Vlastní zdroje (Neon) | hledání ve vlastních dokumentech uživatele s Pro (osobní a týmové knihovny): český fulltext (Snowball stemmer v aplikaci; váhy vlastní nadpis › nadřazený nadpis › tělo › poznámky pod čarou), identifikátory (sp. zn. i s krátkým rokem, §, předpisy i zkratkami „o. z.“/„OSŘ“, ISBN, DOI, ECLI) a metadata — kanály sloučené přes RRF se stropem shod na dokument už v SQL; filtry typu dokumentu, roku, předpisu, jednoho dokumentu a jen poznámek; hit nese cestu oddíly, pinpoint (s., § + m. č., pozn.), výřez se zvýrazněním a pro každou sp. zn. řádek „oficiální text:“ s voláním `ns_search`/`nss_search`/`us_search`/`sdeu_search` |
| `files_get_document` | Vlastní zdroje (Neon) | čtení vlastního dokumentu: u dokumentu nad ~30 stran bez cíle osnova (`toc`), jinak `section` (§, článek, kapitola), `mn` (marginální číslo, i rozsah), `at` (tištěná strana), `footnote`, `find`; okna ≤ 45 000 znaků zarovnaná na celé strany, hlavička „VLASTNÍ DOKUMENT“ s citací ČSN ISO 690, pokračování omezené na zvolený úsek, denní limit čtení na dokument (proti vysávání celých knih) |
| `files_list` | Vlastní zdroje (Neon) | knihovny uživatele a jejich dokumenty (stav, typ, strany, co čeká na potvrzení metadat) a odkaz na nahrávání |
| `zotero_search` | Zotero (api.zotero.org, klíč uživatele) | hledání v připojené knihovně Zotero, jen ke čtení: `mode` `title` (názvy, autoři, roky) / `everything` (všechna pole, poznámky, full-text index příloh), prázdné `title` se samo zopakuje v `everything`; `query`/`queries` (≤ 3 varianty round-robin), `library` (výchozí osobní + skupiny, nejvýš 6), `collection`, `tags` (všechny), `item_type`, `sort`, `limit` (≤ 50 na knihovnu), `page`; shody v přílohách, poznámkách a anotacích seskupené pod dílo; sp. zn. v dotazu navíc projde nejnovější položky `case` (Zotero `q` do `docketNumber` nevidí) a řekne, kolik jich prošla; řazení není podle relevance |
| `zotero_get_item` | Zotero | jedna položka celá: pole po oddílech, abstrakt, extra, štítky, kolekce, poznámky jako text, přílohy (každá s voláním `zotero_get_text`) a anotace prvních PDF; u rozhodnutí řádek „oficiální text:“ |
| `zotero_get_text` | Zotero | text přílohy: full-text index Zotera, když pokrývá celý soubor; jinak PDF ze Zotero Storage přes převodník Vlastních zdrojů (jen v paměti, 10 min); jinak částečný index s varováním nebo důvod, proč text není (neindexováno, WebDAV, odkazovaný soubor, sken, heslo) a co s tím; stránky ~45k znaků, `find` |
| `zotero_list` | Zotero | knihovny (osobní + skupiny klíče), kolekce a štítky; `query`, `limit` (≤ 100), `page` |
| `dawmain_ping` | — | které nasazení odpovědělo |
| `dawmain_probe_sources` | — | diagnostika všech upstreamů z nasazené funkce; `include_raw` pro záchyt fixtures, `discover` pro hledání neověřených endpointů |

Nástroje `files_*` sáhnou do databáze až po třech kontrolách, které se jí
nedotknou, v tomto pořadí: režim z env (`FILES_MODE`) → přihlášení OAuth
(sdílený kód ani anonym nemají uživatele) → knihovna s Pro u Clerku. Kdo
neprojde, dostane jednu chybovou odpověď s pokynem `files_*` v konverzaci
znovu nevolat — Neon se tak neprobouzí kvůli volajícím, kteří Vlastní zdroje
nemají. Veškerý text z dokumentů (i názvy, nadpisy a autoři) jde do plotu
`⟦DOC nonce⟧ … ⟦/DOC nonce⟧` s náhodným nonce na každou odpověď — pro model
data, ne instrukce; nápovědy nástroje jsou až za plotem. Limit 60 volání za
hodinu na uživatele.

Nástroje `zotero_*` pošlou první požadavek na Zotero až po pěti krocích brány
(`zoteroGate` v `src/mcp/tools/zotero.ts`): nasazení má OAuth aplikaci,
`CREDENTIALS_SECRET` i Clerk (`zoteroConfigured`) → osobní přihlášení OAuth
s Pro (`personalProCaller`, stejný nárok jako `files_*`, ale **bez** vypínačů
`FILES_MODE` — Zotero Neon nepotřebuje) → vlastní hodinový limit
`zotero:<userId>` (`LIMITS.toolCallsPerHour` = 120) → pojistka neplatných
klíčů v instanci → uložené připojení z Clerku (žádné / zneplatněné /
nečitelné = připojit znovu na `/?zotero=1`). Odmítnutí kromě limitu a
pojistky říká modelu `zotero_*` v konverzaci znovu nevolat. Obsah knihovny
jde do stejného plotu `⟦DOC nonce⟧` jako u Vlastních zdrojů.

Známá omezení (přiznaná i v popisech nástrojů): NS adresuje jen prvních 900
výsledků dotazu (zužuj dotazem, ne stránkováním) a při řazení podle relevance
hlásí nejvýš 1000 shod (`matched_at_least`); justice.cz drží data od
10/2020, převážně civilní prvoinstanční, a neohraničený fulltext je pomalý.
Odkaz na rozhodnutí NS se zvýrazněním (`&Highlight=0,<termy>`) vrací
`ns_get_decision` s `find` — otevře se rovnou na nalezené pasáži, tedy na tom,
co memo cituje; seznam hitů nese holé odkazy.
Doktrína, živě z produkce (fra1, 2026-09-02): **UKAŽ/Primo odpovídá bez
tokenu** (hledání i full-display záznamu, verbatim fixtures v
`tests/fixtures/primo/`); guest-token fallback zůstává pro případ, že by ho
Primo začalo chtít. **Peace Palace Library (WorldCat Discovery) byla druhým
zdrojem do prvního živého běhu**: Cloudflare odpověděl 403 („Sorry, you have
been blocked") za 50 ms, tedy WAF blokuje adresu nasazení ještě před kódem
OCLC — podpis SPA (`Oclc-Apik`/`Oclc-Apin` na každém volání jiné) by odtud
stejně nepomohl; klient byl vyřazen jako u ÚPV (žádný spící kód; co se o
katalogu zjistilo, zůstává v `docs/research/doctrine-sources.json`, cesta
zpět by vedla přes oficiální WorldCat Search API s WSKey knihovny).
**Plné texty se nečtou.** První verze uměla stáhnout open-access kopii
(Unpaywall, DOI, `unpdf`) a licencované tituly otevřít přes EZproxy UK s
uloženým přihlášením čtenáře (CAS, stránka `/ucet`, hesla zapečetěná v
private metadata Clerku); na přání zadavatele byla celá vrstva odstraněna —
k orientaci v literatuře stačí celý abstrakt a obsah záznamu, které
`doctrine_get_record` vrací (full-display endpoint Prima, ověřený živě,
`tests/fixtures/primo/record-local-book.json`), a text díla si čtenář otevře
sám přes odkaz na záznam (u licencovaných přes vzdálený přístup UK v
prohlížeči). Co se o Unpaywallu, o přihlašovacím řetězu CAS a o proxy
`ezproxy.is.cuni.cz` (host potvrzený HARem zadavatele) zjistilo, zůstává v
`docs/research/doctrine-sources.json`; v kódu nezůstal žádný spící zbytek.
**EUIPO** (eSearchCLW i Guidelines) a **ÚPV** (isdv.upv.gov.cz) záměrně
pokryté nejsou a kód pro ně v repu není: doložky EUIPO si vyhrazují zákaz TDM
a scrapingu „jakýmikoli prostředky, včetně botů" mimo vědecký výzkum (bez
ohledu na objem), ÚPV zahazuje spojení z datacentrových IP (ověřeno živě z
fra1 na obou hostech). Dřív tu klienti leželi nepoužití; byly to nedosažitelné
řádky stárnoucí proti webům, které nikdo nekontroloval. V historii gitu
zůstávají, ale kdyby se zdroje otevřely, stejně by se psaly znovu.

## Architektura

```
app/api/mcp/route.ts        HTTP route + autentizace (OAuth přes Clerk / sdílený kód)
app/.well-known/…/route.ts  RFC 9728/8414 metadata — jak si klient najde OAuth login
proxy.ts                    Clerk proxy (stránky kvůli nabídce účtu, /api, /__clerk;
                            no-op bez klíčů)
src/mcp/auth.ts             ověřování tokenů (Clerk OAuth, sdílený kód), metadata
src/mcp/caller.ts           kdo volá: OAuth uživatel / sdílený kód / anonym
src/mcp/tools/<zdroj>.ts    tenké MCP nástroje (schema → klient → tvar odpovědi)
src/mcp/tools/shared.ts     společné pro všechny nástroje: READ_ONLY anotace,
                            isoDate, toolFailure(), texty popisů (`find`,
                            stránkování) - popisy čte model před každým
                            voláním, takže kopie by ho učila dvě různá pravidla
src/mcp/tools/previews.ts   read_top: paralelní načtení textů nejlepších hitů
src/sources/<zdroj>.ts      klient zdroje; fetchX() (I/O) oddělené od parseX() (pure)
src/sources/shared/         fetchUpstream, CookieSession, chybová taxonomie, char-paging
docs/research/*.json        verbatim rešerše endpointů všech zdrojů
tests/                      unit testy parserů a fetchUpstream proti fixtures;
                            SQL a RLS Vlastních zdrojů proti PGlite (bez sítě)
scripts/smoke.mjs           end-to-end test po drátě (obě generace protokolu)
```

Vlastní zdroje (Pro) — dokumenty, které si uživatel nahraje sám:

```
src/mcp/tools/files.ts      files_search / files_get_document / files_list
src/files/dmd/              DMD (Dawmain Markdown), jediný zdroj pravdy o textu:
                            normalizace, striktní parser, bloky, render s plotem,
                            pinpointy a citace; izomorfní (prohlížeč i server)
src/files/convert/          PDF (pdf.js) / DOCX (mammoth) / TXT / MD → DMD
                            v prohlížeči — originál nikdy neopustí počítač
src/files/text/             český stemmer (vendorovaný Snowball 3.1.1), tokeny,
                            stavba tsquery jen ze sanitizovaných slov
src/files/index/            chunky, tsvector, identifikátory a zkratky předpisů,
                            zvýraznění
src/files/meta/             návrh metadat: heuristiky + Gemini přes AI Gateway
src/files/db/               withScope (transakce + RLS), repozitáře, migrace
                            v čistém SQL (migrations/)
src/files/access.ts         Clerk → knihovny (osobní / týmové), Pro, role, kvóty
src/files/guards.ts         režim (env, přepínač provozovatele, pojistky free
                            tieru) a rate limit
src/files/upload.ts         nahrání: kontroly, rezervace kvóty, zápis textu
src/files/ingest.ts         zpracování po nahrání (after(), lease v řádku DB)
app/vlastni-zdroje/         vstup do Vlastních zdrojů na webu (modální okno nad
                            stránkou, /?zdroje=moje); provoz/ = stránka provozovatele
app/api/files/…             nahrání, stav zpracování, souhrn, dokumenty, správa týmu
app/api/webhooks/clerk/     smazání účtu / týmu → výmaz knihovny po 7 dnech
app/api/cron/files/         denní úklid a pojistky (vercel.json, 03:00 UTC)
scripts/db-migrate.mjs      migrace — ručně, vlastnickým připojením
```

Zásady: každý nástroj má `annotations` (vše read-only; `files_*` navíc
`openWorldHint: false`), stránkování
(`limit`/`offset` či `page`, `has_more`), čitelný text a
chybové hlášky, které říkají, co zkusit jinak (`PARSE_DRIFT` = upstream změnil
layout → spusť probe). Kde se dá kritérium ztratit (přejmenovaná pole
formuláře NSS), se raději hlásí `PARSE_DRIFT` než tipuje podle datového typu:
tichá odpověď na jinou otázku je pro rešerši horší než chyba. Klient dostává
**jen text**: `registerAllTools` (`src/mcp/tools/index.ts`) při registraci
zahazuje `outputSchema` i `structuredContent` — Claude Code jinak předával
modelu JSON místo textu (dražší a bez textových upozornění). Handlery
strukturovaný výstup dál vracejí jako interní, testovaný kontrakt; cokoli
potřebuje model (odkaz k citaci, varování, pokračování), musí být v textu.
Jména nástrojů: `<zdroj>_search` hledá, `<zdroj>_get_*` čte (`us_` = Ústavní
soud, `sdeu_` = SDEU, `caselaw_search` = všechny vrcholné soudy naráz). Rychlost: opakovaná identická volání jdou z per-instance
cache (5 min hledání, 10 min texty rozhodnutí — stránka 2 dokumentu už text
nestahuje znovu) a vícestránkové smyčky (e-Sbírka §-scan, justice day-walk,
vícedílné dokumenty v Cellaru) běží v malých paralelních dávkách — stejný
počet requestů na upstream, zlomek času.

## Vývoj

```bash
npm install
npm run dev          # http://localhost:3000, endpoint /api/mcp
npm test             # unit testy parserů (fixtures, bez sítě)
npm run typecheck
npm run smoke        # po drátě proti běžícímu serveru (bez upstreamů)
```

Pozor: soudní weby nejsou dostupné z každé sítě (CI, sandboxy). Integrační
ověření se dělá **proti nasazení**:

```bash
MCP_URL=https://<deployment>.vercel.app/api/mcp MCP_BEARER_TOKEN=… npm run smoke
MCP_URL=… MCP_BEARER_TOKEN=… SMOKE_LIVE=1 npm run smoke   # + reálné dotazy do zdrojů
```

## Nasazení na Vercel

Repo je propojené přes Git integraci — push nasadí preview, merge do `main`
produkci. Next.js si Vercel detekuje sám; `vercel.json` nese jen denní cron
Vlastních zdrojů. Node ≥ 22 (`engines` v `package.json`, vyžaduje ho `ai@7`).
Vlastní zdroje se zapínají zvlášť — viz [Vlastní zdroje — provoz](#vlastní-zdroje--provoz).

**Po prvním nasazení:**

1. *Project Settings → Environment Variables*: `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
   + `CLERK_SECRET_KEY` a/nebo `MCP_BEARER_TOKEN`, `ESBIRKA_API_KEY` (viz
   `.env.example`); *Functions → Region*: `fra1`. Po změně env je potřeba
   Redeploy.
2. *Project Settings → Functions → Fluid compute*: musí být **zapnuté** (u
   projektů založených od roku 2025 výchozí; `vercel.json` ho navíc žádá
   pro každé nasazení přes `"fluid": true`, ale ověř to). Pět cest Vlastních
   zdrojů má `maxDuration = 300` (`/api/files/documents`,
   `/api/files/documents/[id]`, `/api/files/status`, `/api/cron/files`,
   `/vlastni-zdroje/provoz`); bez Fluid dovolí Hobby nejvýš 60 s — nasazení
   takovou hodnotu odmítne, nebo zpracování dlouhého dokumentu uřízne. Na Fluid
   počítá i `attachDatabasePool` v `src/files/db/client.ts` (zavře nečinná
   spojení do Neonu, než se instance uspí).
3. Spusť smoke proti nasazení (viz výše), pak `SMOKE_LIVE=1`.
4. Zavolej `dawmain_probe_sources` — ověří všechny upstreamy z nasazení.
5. `dawmain_probe_sources {discover: true}` vypíše skutečná pole formuláře
   NSS — slouží k doladění mapování v `src/sources/nss.ts`.
6. `dawmain_probe_sources {include_raw: true, sources: ["ns"]}` zachytí syrové
   tělo odpovědi jako podklad pro fixture (po jednom zdroji — všechny naráz se
   nevejdou do rozpočtu odpovědi).

## Připojení klienta

S OAuth (Clerk) stačí URL — klient si při prvním použití řekne o přihlášení
(`/mcp` → authenticate v Claude Code, v claude.ai se okno otevře samo):

```bash
claude mcp add --transport http dawmain https://<deployment>.vercel.app/api/mcp
```

S přístupovým kódem (hodí se pro CI a skripty):

```bash
claude mcp add --transport http dawmain https://<deployment>.vercel.app/api/mcp --header "Authorization: Bearer <token>"
```

```json
{
  "mcpServers": {
    "dawmain": {
      "type": "http",
      "url": "https://<deployment>.vercel.app/api/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

## Skill pro Claude

`skills/dawmain-reserse/SKILL.md` je rešeršní návod pro Claude nad tímto
konektorem: jak z faktů udělat cílený dotaz (slovník předpisu místo slov
klienta, tři varianty na jedno volání), které filtry zužují hledání u kterého
soudu, kdy přestat hledat a jak vypadá výstupní memo. Instrukce serveru
(`src/mcp/server.ts`) klient cachuje od initialize, skill se dá měnit hned —
proto v něm žije to, co se ladí často.

Instalace: nahrát adresář jako skill v claude.ai (Nastavení → Capabilities →
Skills). Skill předpokládá připojený konektor Dawmain; bez něj se má ozvat,
ne hádat.

## Výkon a šetrnost ke zdrojům

- Neměnná data se cachují per warm instance: metadata a historie znění
  e-Sbírky (10 min), NSS handshake (10 min), texty dokumentů (10 min)
  a výsledky hledání (5 min).
- NS: fulltext hledá v celé databázi a řadí se podle relevance
  (`SearchOrder=1`). Dřív se používalo pořadí pohledu (`SearchOrder=4`), což
  je pořadí interních UNID — prvních 20 z 1 501 shod byla náhodná směs let
  1999–2023. Relevance ale vrací řádky jen od začátku seznamu (živě ověřeno:
  `Start=21`, `101`, `401` = prázdná tabulka), takže se čte vždy od `Start=0`
  po blocích 100 řádků a stránka se odřízne lokálně; banner pak počítá nejvýš
  `SearchMax` (1000). Víc slov bez operátoru Domino bere jako jednu přesnou
  frázi (`nájemce výpověď` = 1 rozhodnutí, s AND 1 501), proto se holá slova
  spojují AND; sp. zn. zůstává frází, výraz s uvozovkami, závorkami nebo
  operátorem jde nahoru beze změny. Dřív tu byla záchrana, která odmítnutý bezdatumový dotaz tiše
  zopakovala v okně 12 měsíců a pak 90 dnů; byl to workaround na HTTP 500,
  které způsoboval náš vlastní malý `Count` (viz `NS_MIN_COUNT`), a po jeho
  opravě už jen schovávala archiv, aniž by se kdo ptal. Odmítnutí se dnes
  hlásí jako odmítnutí. Domino odmítá malé `Count`, takže se vždy žádá aspoň
  20 řádků a ořezává se lokálně.
- Scan § v e-Sbírce je stropovaný 15 stránkami a končí hned po naplnění
  limitu (SPARQL rychlá cesta v 2026-09 nevracela žádné fragmenty, takže § jde
  v praxi přes scan; články se vyřezávají z textu podle řádku „Čl. N“, max. 20
  stránek); hledání na justice.cz má 45s timeout a jen jeden pokus
  (neohraničený fulltext je nad výchozích 15 s).
- Texty dokumentů se vracejí po stránkách 45 000 znaků (bezpečně pod limity klientů) — typické rozhodnutí
  v jedné odpovědi; delší texty nesou pokyn agentovi pokračovat bez ptaní.
- Timeouty: výchozí 15 s/request; odchylky: NSS POST 25 s, Cellar retrieval 25 s,
  Cellar SPARQL 30 s, justice.cz hledání 45 s, e-Sbírka SPARQL 20 s, katalogy
  doktríny 20 s.
- Délka invokace: `/api/mcp` má `maxDuration = 60`. Hobby s Fluid compute by
  dovolil až 300 s, ale odpověď nástroje má přijít dřív, než to klient vzdá, a
  delší běh jen ukrajuje z měsíčního rozpočtu Hobby (Active CPU, paměť), jehož
  překročení pozastaví celý tým. Pomalé zdroje proto mají timeouty pod touto
  hranicí. Až 300 s běží jen nahrání a zpracování dokumentu Vlastních zdrojů.

## Autentizace

Endpoint přijímá dvě credentials naráz (stačí kterákoli); logika žije v
`src/mcp/auth.ts`:

1. **OAuth 2.1 přes Clerk** (`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` +
   `CLERK_SECRET_KEY`, musí být OBĚ) — klient dostane na `401` hlavičku
   `WWW-Authenticate` s odkazem na `/.well-known/oauth-protected-resource`,
   tam najde autorizační server (Clerk instance, doména je zakódovaná v
   publishable key), sám se u něj zaregistruje (Dynamic Client Registration)
   a provede uživatele přihlášením — e-mail + heslo, e-mailový kód či SSO,
   podle toho, co je v Clerku zapnuté. Přihlašovací stránku hostuje Clerk
   Account Portal; server jen ověřuje předložené OAuth tokeny přes Clerk
   (`verifyClerkToken`), k čemuž potřebuje secret key. `proxy.ts` (Clerk
   middleware na stránkách, `/api` a `/__clerk`; bez `protect()`, takže nic
   nezamyká) je to, co `auth()` v route zprovozňuje; bez klíčů je no-op.
2. **Sdílený přístupový kód** (`MCP_BEARER_TOKEN`) — původní schéma,
   ponechané pro existující klienty; token se přijímá z `Authorization`,
   `X-API-Key` i `cf-aig-authorization` (stačí, když sedí kterákoli).

**Bez těchto proměnných se na Vercelu odmítne všechno** — prázdná nebo chybějící
konfigurace by jinak tiše zveřejnila celý server, a to i na preview adresách;
proto proměnné zaškrtni pro Production i Preview. Anonymní provoz je možný jen
lokálně. Aktuální stav hlásí `dawmain_ping` polem `auth`
(`oauth+token` / `oauth` / `token` / `open`).

### Nastavení Clerku (jednorázově, dashboard.clerk.com)

1. **Přihlašovací metody**: v aplikaci *Configure → Email, phone, username*
   nech zapnutý e-mail (heslo a/nebo e-mailový kód). Sociální přihlášení
   (Google apod.) jde kdykoli přidat v *SSO connections* — čistě dashboard,
   kód se nemění.
2. **Dynamic Client Registration** (nutné pro MCP klienty typu claude.ai):
   *Configure → OAuth applications → povolit Dynamic Client Registration*.
3. **API klíče**: *Configure → API keys* → `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
   a `CLERK_SECRET_KEY` vlož na Vercelu (Production i Preview) a Redeploy.
4. **Kdo se smí registrovat**: veřejná registrace pustí dovnitř kohokoli.
   Adresné rozdávání přístupu = *Configure → Restrictions* (allowlist /
   vypnout sign-up) a uživatele zvát z dashboardu (*Users → Invite*).

Ověření: `curl https://<host>/.well-known/oauth-protected-resource` musí
vrátit `authorization_servers` s doménou tvé Clerk instance (tvar
`https://<slug>.clerk.accounts.dev`, u produkce `https://clerk.<doména>`);
pak připoj konektor v claude.ai bez přístupového kódu — má se otevřít
přihlašovací okno. Diskovery kontroluje i `npm run smoke` (krok
`oauth discovery`).

## Vlastní zdroje — provoz

Uživatel s Pro si na webu nahraje vlastní dokumenty; prohlížeč je převede na
text (DMD), server ho uloží do Neon Postgresu ve Frankfurtu, zaindexuje
(český stemmer běží v aplikaci), navrhne metadata (heuristiky + Gemini přes
AI Gateway) a hned po zpracování v nich hledají nástroje `files_*` (metadata
uživatel opraví v detailu dokumentu; krok kontroly před hledáním zapne knihovně
`settings.autoConfirm = false`). Originály se
nikam neukládají. Všechno běží zdarma: Vercel Hobby, Clerk, Neon Free a
měsíční kredit AI Gateway. **Překročení limitů Hobby pozastaví celý tým
včetně `/api/mcp`**, Neon při vyčerpání zablokuje zápisy nebo uspí databázi do
konce měsíce — proto pojistky níže. Bez nastavení je funkce vypnutá
(`FILES_MODE` chybí → `off`, chybí `FILES_DATABASE_URL` → `unconfigured`).

**Před spuštěním** si přečti *Vercel → Usage* za posledních 30 dní (Active
CPU 4 h, paměť 360 GB-h, 1M invokací, Fast Origin Transfer 10 GB) a nech
Vlastním zdrojům nejvýš čtvrtinu zbývající rezervy.

### Neon (Vercel Marketplace)

1. *Vercel → Storage → Neon*: region **Frankfurt** (`aws-eu-central-1`),
   plán **Free**. Compute pevně **0,25 CU** (autoscaling nahoru nepouštěj:
   2 CU spálí 100 CU-h osmkrát rychleji); scale-to-zero po 5 min zůstává.
2. **Preview branching vypnout.** Větve se počítají do 0,5 GB i do stejných
   CU-h. Preview proto Vlastní zdroje nemá vůbec (`FILES_MODE=off`, žádné
   další `FILES_*`) — jinak by psalo do produkčních dat.
3. Integrace vloží do projektu `DATABASE_URL`, `DATABASE_URL_UNPOOLED` a
   `PG*` s vlastnickou rolí. Aplikace je nečte (vlastník obchází RLS a
   fallback na něj záměrně neexistuje) — nech je jen v Production, nebo je
   z projektu odeber.

### Migrace a role aplikace

Migrace (`src/files/db/migrations/*.sql`) se pouštějí ručně z terminálu,
vlastnickým přímým připojením (host bez `-pooler`), **před** nasazením, které
je potřebuje — nikdy při buildu:

```bash
DATABASE_URL_UNPOOLED='postgresql://neondb_owner:…@ep-….eu-central-1.aws.neon.tech/neondb?sslmode=require' \
  node scripts/db-migrate.mjs
```

Skript aplikuje čekající soubory podle jména, každý ve vlastní transakci, a
zapíše je do `schema_migrations` s kontrolním součtem; `--dry-run` jen vypíše,
co čeká. Už aplikovaný soubor se nemění — oprava = nový soubor.

| Soubor | Co přináší |
| --- | --- |
| `0001_init.sql` | tabulky knihoven, dokumentů, textu, stran, oddílů, poznámek, chunků, počítadel, aktivity DB, stavu, souhlasů, auditu a blokací (`blocked_content`) |
| `0002_rls.sql` | role `dawmain_app`, row-level security, systémové funkce (rezervace stran, součty, seznam knihoven, fronta zpracování) |
| `0003_ops.sql` | rozpočet přeindexování (`usage_daily.reindexes`, `documents.reindex_requested_at`), `files_db_usage()` a `files_table_usage()` (živá data, plán `VACUUM FULL`), úklid auditu vymazaných knihoven, oznámení a odstranění napříč knihovnami, noční přepočet počítadel |
| `0004_search.sql` | kanály hledání jako funkce `SECURITY DEFINER` (`files_search_chunks`, `files_search_meta`), aby dotazy role aplikace šly přes GIN indexy |

**Tahle verze potřebuje `0003` a `0004`** — pusť `--dry-run`, pak migraci,
a teprve potom nasazuj. Všechny přidávají jen sloupce `IF NOT EXISTS`, indexy
a funkce, na data nesahají. Po nasazení je navíc potřeba přeindexovat starší
dokumenty (`ANALYZER_VERSION` 2, viz Kapacita).

Migrace `0002` založí roli `dawmain_app` SQL příkazem — jen taková role na
Neonu nepatří do `neon_superuser` a neobchází RLS (roli proto nezakládej ani
neupravuj v konzoli Neonu). Heslo jí dej jednou v SQL editoru Neonu jako
vlastník; do gitu nepatří:

```sql
ALTER ROLE dawmain_app WITH LOGIN PASSWORD '<dlouhé náhodné heslo>';
```

`FILES_DATABASE_URL` pak míří na **pooler** s touto rolí:
`postgresql://dawmain_app:<heslo>@ep-…-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require`.
Klient při prvním připojení ověří, že role nemá `rolbypassrls`, jinak odmítne
běžet; `withScope` nastavuje knihovny jen transakčně, takže pooler v režimu
transakcí je bezpečný.

### Proměnné prostředí

Vše **jen pro Production**; pro Preview nastav `FILES_MODE=off` (a nic
dalšího kromě tří proměnných Zotera na konci tabulky). Po změně Redeploy.

| Proměnná | Význam | Výchozí |
| --- | --- | --- |
| `FILES_MODE` | hlavní vypínač: `on`, `readonly` (hledání, čtení a mazání, bez nahrávání), `off` | `off` |
| `FILES_DATABASE_URL` | pooled URL role `dawmain_app`; bez ní `unconfigured` | — |
| `DATABASE_URL_UNPOOLED` | vlastnické přímé připojení, jen pro `scripts/db-migrate.mjs` z terminálu; aplikace ho nečte | — |
| `FILES_META_MODEL` | model pro návrh metadat přes AI Gateway | `google/gemini-2.5-flash-lite` |
| `FILES_USER_HASH_SECRET` | klíč HMAC pro pseudonym nahrávajícího, který dostává AI Gateway k rozpočítání spotřeby (`gateway.user`, čte `src/files/ingest.ts`); dlouhý náhodný řetězec. Změna klíče = nové pseudonymy v přehledu Gateway | `CLERK_SECRET_KEY` |
| `FILES_GLOBAL_MAX_PAGES` | strop stran pro celou instalaci | 30 000 |
| `FILES_PERSONAL_PAGES` | kvóta osobní knihovny (stran) | 3 000 |
| `FILES_TEAM_PAGES` | kvóta týmové knihovny (stran) | 10 000 |
| `FILES_OPERATOR_IDS` | Clerk `user_…` oddělená čárkou — přístup na `/vlastni-zdroje/provoz` | — |
| `FILES_AI_BUDGET_USD` | klouzavý 30denní rozpočet AI v celých USD; nad ním jen heuristiky | 4 |
| `FILES_GLOBAL_UPLOADS_PER_DAY` | nahrání za den ve všech knihovnách dohromady | 200 |
| `FILES_CPU_MS_DAY` | CPU zpracování (nahrání, zpracování, přeindexování) za den v ms | 600 000 (10 min) |
| `FILES_CPU_MS_30D` | totéž za klouzavých 30 dní — čtvrtina 4 h Active CPU Hobby | 3 600 000 (60 min) |
| `CLERK_WEBHOOK_SIGNING_SECRET` | podpisový klíč webhooku Clerku (`whsec_…`) | — |
| `CRON_SECRET` | Vercel ho posílá cronu jako `Authorization: Bearer …`; bez něj cron odmítne všechno | — |
| `AI_GATEWAY_API_KEY` | jen lokálně (`.env.local`); na Vercelu se Gateway ověřuje přes OIDC a klíč by ho přebil | — |
| `ZOTERO_OAUTH_CLIENT_KEY` | Zotero: Client Key aplikace z zotero.org/oauth/apps; nastavuje se **i pro Preview** (viz Zotero — provoz) | — (Zotero vypnuté) |
| `ZOTERO_OAUTH_CLIENT_SECRET` | Zotero: Client Secret téže aplikace | — (Zotero vypnuté) |
| `CREDENTIALS_SECRET` | Zotero: klíč pečetění uložených klíčů (AES-256-GCM přes HKDF), ≥ 32 znaků, `openssl rand -base64 32`; změna = všichni připojí Zotero znovu | — (Zotero vypnuté) |

Strana = 3 600 znaků převedeného textu včetně poznámek (`PAGE_CHARS`); cenu
ve stranách vidí uživatel před nahráním. Kvóta jednoho uživatele nebo týmu jde
přepsat v Clerku (níže).

### Clerk

1. *Configure → Organizations*: zapnout, **Membership optional** (osobní
   účty zůstanou; s „required“ by každý uživatel včetně těch, kdo jen
   připojují MCP, dostal úkol vybrat si organizaci), **vypnout Allow
   user-created organizations**. Výchozí limit je 5 členů na tým; zdarma jde
   zvednout nejvýš na 20.
2. **Tým zakládej ty, s jeho budoucím správcem jako tvůrcem** — kdybys ho
   založil za sebe, stal by ses členem a viděl bys týmové dokumenty. Pak
   vypni mazání týmu adminem (smazání týmu = výmaz celé knihovny):

   ```bash
   curl -sS https://api.clerk.com/v1/organizations \
     -H "Authorization: Bearer $CLERK_SECRET_KEY" -H 'Content-Type: application/json' \
     -d '{"name":"AK Novák","created_by":"user_…","max_allowed_memberships":20,"public_metadata":{"pro":true}}'
   curl -sS -X PATCH https://api.clerk.com/v1/organizations/org_… \
     -H "Authorization: Bearer $CLERK_SECRET_KEY" -H 'Content-Type: application/json' \
     -d '{"admin_delete_enabled":false}'
   ```

3. **Pro se přiděluje v public metadata** (*Users → uživatel → Metadata*,
   resp. *Organizations → tým → Metadata*): `{ "pro": true }` — přesně
   boolean `true`. Vlastní kvóta: `{ "pro": true, "filesQuota": { "pages": 5000 } }`.
   Projeví se do minuty (přístup se cachuje 60 s). Členové týmu s Pro nahrávat
   smějí všichni; správce (`org:admin`) upravuje a maže všechno, člen jen své.
4. **Odebrání Pro**: smaž `pro`. Denní cron to zaznamená (`pro_revoked_at`);
   asistent v knihovně přestane hledat, uživatel ji 90 dní vidí, může mazat
   a stahovat text svých dokumentů („Exportovat text“), pak se smaže. Vrátí-li
   se Pro dřív, než výmaz proběhne, cron označení zruší (nahrání do knihovny
   ji oživí hned). **Před smazáním mu napiš** (slibují to zásady ochrany
   osobních údajů); knihovny s odebraným Pro ukazuje stránka provozu.
5. **Webhook**: *Configure → Webhooks → Add endpoint*
   `https://<doména>/api/webhooks/clerk`, události `user.deleted`,
   `organization.deleted`, `organizationMembership.deleted`; *Signing
   secret* → `CLERK_WEBHOOK_SIGNING_SECRET` (Production) → Redeploy. Smazání
   účtu nebo týmu označí knihovnu k výmazu za 7 dní (vymaže ji denní cron).
   Doručení Clerk nezaručuje; výpadek webhooku zachytí denní kontrola Pro
   v cronu (smazaný účet ani tým Pro nemá).

### AI Gateway (návrh metadat)

1. *Vercel → AI Gateway*: přidej kartu — bez ní se Hobby nedostane k
   bezplatnému kreditu **5 USD na 30 dní** (hodiny běží od prvního požadavku).
2. Zkontroluj seznam modelů zdarma (`vercel.com/ai-gateway/models?freeTier=true`)
   a nastav `FILES_META_MODEL` na Gemini Flash-Lite, který v něm je. Řada 2.5
   končí kolem 16.–20. 10. 2026; modely Claude zdarma nejsou.
3. **Auto-recharge vypnutý a kredit nekupovat** — první nákup ukončí
   bezplatný kredit natrvalo.
4. Na Vercelu se Gateway ověřuje sama přes OIDC. `AI_GATEWAY_API_KEY` patří
   jen do lokálního `.env.local`; na Vercelu by OIDC přebil.

Požadavky nesou `disallowPromptTraining: true` a text dokumentu jen jako data
(bez nástrojů, `maxOutputTokens` 1000). Selhání AI nahrání neblokuje — zůstanou
heuristiky. **Model jiného poskytovatele než Google = nový subdodavatel**:
nejdřív uprav `/soukromi` a dej uživatelům vědět (viz Právní texty níže).

### Pojistky bezplatných limitů

- **Automaticky** (`src/files/guards.ts`, cache 30 s): živá data DB ≥ 80 %
  z 400 MB nebo součet stran ≥ 80 % z `FILES_GLOBAL_MAX_PAGES` → jen pro
  čtení; odhad CU-h ≥ 70 % ze 100 → jen pro čtení, ≥ 90 % → vypnuto. Jen pro
  čtení = hledání, čtení a mazání jdou, nahrávání ne.
- **Živá data vs. soubory**: pojistka DB čte odhad živých dat
  (`files_db_usage()`: fyzická velikost minus volné místo, které po sobě
  nechávají smazané řádky — z katalogových statistik). Smazání dokumentů
  proto režim jen pro čtení zruší, jakmile doběhne autovacuum. Soubory samy se
  mazáním nezmenší: fyzická velikost ≥ 400 MiB (strop vlastníka, 100 %)
  vypne nahrávání vždy — Neon počítá všechny databáze projektu a pojistka se
  měří jen po 30 s.
- **Zmenšení souborů** (`VACUUM FULL`): stránka provozu ukáže plán, jakmile
  jde uvolnit aspoň 20 % stropu — pořadí tabulek, které se vejdou, a ty, které
  se nevejdou, dokud z nich nesmažeš dokumenty. Pouštěj jako vlastník, v
  klidném okně, **tabulky po jedné** (každá je po dobu přepisu zamčená).
  Přepis zapíše novou kopii tabulky i indexů, než smaže starou — potřebuje
  volné místo pod 0,5 GB Neonu zhruba ve velikosti živých dat té tabulky.
- **CPU zpracování**: nahrání, zpracování a přeindexování si zapisují vlastní
  čas CPU (`usage_daily.cpu_ms`, jen synchronní práce — ne čekání na síť ani
  cizí požadavky na téže instanci). Nad 10 min za den nebo 60 min za 30 dní
  (čtvrtina 4 h Active CPU Hobby; `FILES_CPU_MS_DAY`, `FILES_CPU_MS_30D`)
  se nové nahrání odmítne (429) a přeindexování počká; nad 200 nahrání za den
  ve všech knihovnách také (`FILES_GLOBAL_UPLOADS_PER_DAY`). Číslo je spodní
  odhad účtovaného Active CPU — porovnej ho se stránkou Usage na Vercelu.
- **Odhad CU-h**: Neon Free nemá API spotřeby, aplikace si proto zapisuje
  každou minutu, kdy sáhla do DB (`db_activity`), a počítá sjednocení
  intervalů [minuta, minuta + 5 min] × 0,25 CU. Každé probuzení stojí aspoň
  5 minut — i proto nástroje nesahají do DB kvůli volajícím bez Pro.
- **Vypínač**: přepínač režimu na stránce provozu (`system_state`, bez
  redeploye, projeví se do 30 s), nebo `FILES_MODE=off` + Redeploy. Když
  pojistky vypnou funkci kvůli CU-h (90 %), každá instance si to pamatuje do
  začátku dalšího měsíce UTC a DB kvůli tomu nebudí; přepínač „off“ se ale
  čte každých 30 s. **Probouzení DB úplně zastaví jen `FILES_MODE=off` +
  Redeploy.**
- Pool nenastavuje žádné startovní parametry (pooler Neonu
  `statement_timeout` při startu spojení odmítne); `withScope` nastavuje
  `statement_timeout` pro každou transakci (`set_config(…, true)`): 10 s,
  60 s pro zpracování, přeindexování a výmaz. `connectionTimeoutMillis` 4 s —
  uspaný Neon dá rychlou odpověď „dočasně nedostupné“, ne 60 s čekání.
- **Přeindexování po uložení metadat** (změna typu dokumentu nebo
  komentovaného předpisu): nejvýš 20 za den na knihovnu; žádné, dokud je
  vyčerpaná společná rezerva CPU (výše). Opakované uložení během běžícího
  přeindexování se k němu připojí. Odmítnuté zůstanou označené a dožene je
  denní cron.
- Denní cron (`/api/cron/files`, 03:00 UTC; Hobby smí jednou denně s
  přesností na hodinu): pojistky a velikost DB; výmaz knihoven po lhůtě
  (knihovnu, kterou mezitím nahrání oživilo, nechá být); kontrola Pro (≤ 50
  dotazů do Clerku; obnovené Pro u knihovny označené k výmazu po 90 dnech
  označení zruší; u smazaného účtu, který minul webhook, zahodí i souhlas s
  podmínkami a počítadla čtení); restart zaseknutých zpracování; dohnání
  odložených přeindexování (≤ 30 za běh, jen v režimu „on“ a jen s volnou
  rezervou CPU); úklid textu neúspěšných nahrání po 7 dnech; noční přepočet
  `page_count`/`doc_count`/`pages_reserved` všech knihoven z jejich dokumentů;
  retence — `usage_daily` 12 měsíců, počítadla čtení dokumentů 2 dny,
  `db_activity` 62 dní, auditní záznamy vymazaných knihoven kromě
  `library.purged`.

### Kapacita

Odhad je 9–12 KB databáze na stranu (text uložený jednou a komprimovaný,
chunky s tsvectorem, GIN, strany, oddíly, poznámky), tedy **zhruba 30 000
stran** v 0,5 GB — horní odhad; do změření drž `FILES_GLOBAL_MAX_PAGES` raději
na 20 000. **Po prvních 3 skutečných knihách změř** (SQL editor Neonu jako
vlastník — roli aplikace RLS nic neukáže):

```sql
SELECT relname, pg_size_pretty(pg_total_relation_size(oid))
  FROM pg_class
 WHERE relname IN ('documents','doc_blocks','doc_pages','doc_sections','doc_footnotes','chunks')
 ORDER BY pg_total_relation_size(oid) DESC;

SELECT (SELECT sum(pg_total_relation_size(t::regclass))
          FROM unnest(ARRAY['documents','doc_blocks','doc_pages','doc_sections','doc_footnotes','chunks']) t)
       / nullif((SELECT sum(billable_pages) FROM documents WHERE status IN ('review','ready')), 0)
       AS bytes_per_page,
       (SELECT avg(pg_column_size(tsv)) FROM chunks) AS avg_tsv_bytes;
```

`FILES_GLOBAL_MAX_PAGES` pak nastav zhruba na 300 MB ÷ `bytes_per_page` a
podle toho kvóty. Přeindexování (po zvýšení `ANALYZER_VERSION`) jen po
dávkách tlačítkem „Přeindexovat dávku“ na stránce provozu: odmítne se mimo
režim „on“ a nad 60 % DB má dávka nejvýš 10 dokumentů.

`ANALYZER_VERSION` 2 přidal k úsekům klíče předpisů EU, které cituje
(`eu:<CELEX>`: „GDPR“, „nařízení (EU) 2016/679“, „směrnice 93/13/EHS“) —
filtr `act` u předpisu EU pak vrací i pasáže, které ho citují, nejen
komentáře k němu. Dokumenty nahrané dřív to umí až po přeindexování.

**Zálohy nejsou.** Neon Free drží 6 h historie změn a nabízí jeden ruční
snapshot — **snapshot nedělej a obsah nedumpuj**: smazané dokumenty by
přežily déle, než slibuje `/soukromi` (nejvýš 6 hodin). Originály mají
uživatelé u sebe a podmínky výslovně říkají, že záloha není.

**Další placený krok**: Neon Launch (platí se podle spotřeby, při tomhle
objemu řádově 5–15 USD měsíčně). Pak zvedni `LIMITS.dbBytesCap`
(`src/files/config.ts`) a stropy stran; delší historie obnovy (Launch až
7 dní) znamená upravit dobu v `/soukromi`.

### Stránka provozu

`/vlastni-zdroje/provoz` (jen `FILES_OPERATOR_IDS`): pojistky proti limitům
(živá data i fyzická velikost DB, strany, odhad CU-h, rozpočet AI, CPU
zpracování za den a 30 dní, nahrání za měsíc), plán `VACUUM FULL`, knihovny,
zaseknuté dokumenty, přepínač režimu, „Přeindexovat dávku“ (≤ 200 dokumentů
z uloženého textu na kliknutí; mimo režim „on“ odmítnuto, nad 60 % DB nejvýš
10) a oznámení a odstranění obsahu (níže).

### Export textu

Kdo dokument nahrál, a správce týmu u všech týmových, si v detailu stáhne jeho
uložený text („Exportovat text“, `GET /api/files/documents/[id]/export?lib=`):
DMD s hlavičkou metadat (název, autoři, rok, typ, původní soubor, knihovna,
data). Pro není potřeba — tak se plní slib `/soukromi` na 90 dní po odebrání
Pro i právo na přenositelnost; nejde jen při `FILES_MODE=off`. Stropy: jeden
dokument nejvýš 10× za den (`EXPORTS_PER_DOC_PER_DAY`) a jeden uživatel za den
tolik stran, kolik má největší kvóta knihovny (`max(FILES_PERSONAL_PAGES,
FILES_TEAM_PAGES)`) — jinak 429. Počítadla `read:<uživatel>:…` maže cron po 2
dnech, každé stažení zapíše audit `document.export` (délka, ne text). Když
export nejde a uživatel napíše (zásady slibují pomoc), zapni funkci aspoň
v režimu `readonly` — export v něm běží — a dej mu vědět.

### Nezákonný obsah

Kontaktní místo podle DSA čl. 11 a 12 (úřady, Komise i uživatelé) je e-mail
`CONTACT` z `app/_legal.tsx`, česky a anglicky; podmínky slibují, že odpovídáš
osobně. Když se adresa změní, změní se v obou textech najednou.

Podmínky slibují postup pro oznámení (DSA čl. 16): ověř oznámení, obsah
odstraň a zablokuj, aby nešel nahrát znovu, a nahrávajícímu pošli odůvodnění
(DSA čl. 17). Na stránce provozu v oddílu **„Oznámení a odstranění obsahu“**
zadej ID dokumentu nebo SHA-256 jeho textu a odkaz na oznámení a potvrď.
Hash se zablokuje, smažou se všechny kopie ve všech knihovnách (se správně
vrácenými stranami) a zapíšou se auditní záznamy (`content.takedown`,
`document.takedown`); výsledek zůstane na stránce. Blokace platí jen pro
přesně tentýž převedený text (normalizovaný) — jiný převod téhož díla má jiný
hash. Počítadla stran knihoven ručně neupravuj: odchylky opraví noční
přepočet v cronu.

### Právní texty

Sliby v `/soukromi` a `/podminky` visí na konkrétních hodnotách — když se
změní, změň i text, zvedni `EFFECTIVE` v `app/_legal.tsx` a napiš uživatelům
měsíc předem (podmínky to slibují). `tests/files-legal-texts.test.ts` hlídá
ty, které jdou přečíst z kódu.

- zpracovatelé: Clerk, Vercel (+ Google přes AI Gateway), Neon — jiný model
  nebo nová služba = nový subdodavatel; Gateway dostává jen pseudonym
  nahrávajícího (`FILES_USER_HASH_SECRET`);
- výmaz knihovny 7 dní po smazání účtu/týmu (+ nejvýš den do cronu → text
  říká „do 8 dnů“), 90 dní po odebrání Pro, 6 h historie Neonu; po výmazu
  zůstane řádek knihovny bez jména a auditní záznam `library.purged`;
- retence v cronu: text neúspěšného nahrání 7 dní, počítadla čtení a stažení
  2 dny, ostatní počítadla 12 měsíců, audit do výmazu knihovny;
- export textu („Exportovat text“) — i po odebrání Pro;
- kontaktní místo DSA (čl. 11 a 12): `CONTACT`, česky a anglicky;
- region Frankfurt u Vercelu i Neonu, rozsah textu k návrhu metadat
  (~16 000 znaků), cookies Clerku;
- Zotero: není zpracovatel (službu si připojuje uživatel, Dawmain na jeho
  pokyn čte), klíč jen ke čtení a zašifrovaný v `privateMetadata` Clerku,
  klíč s právem zápisu se odmítne a zruší, obsah knihovny jen v dočasné
  paměti (≤ 10 min), stažené PDF se neukládá, cookie `dz_zotero_oauth`
  (≤ 10 min) při připojování; po smazání účtu klíč zůstane na zotero.org.

Znění s Vlastními zdroji má `EFFECTIVE` 1. 11. 2026 a na `main` ještě není
(tam platí 1. 9. 2026). Dokud se nenasadí, dá se upravovat bez posunu data.
E-mail uživatelům ale musí odejít nejpozději měsíc před účinností, tedy do
1. 10. 2026 — když se to nestihne, posuň `EFFECTIVE` tak, aby měsíc zbyl.

### Evaluace vyhledávání

`scripts/files-eval.mjs` pustí sadu dotazů stejnou cestou jako `files_search`
(identifikátory, `buildTsQuery`, filtr předpisu, kanály, RRF, sloučení
variant, 2 pasáže na dokument) a vypíše **recall@5** a **MRR** po pasážích i
po dokumentech. Podle plánu rozhoduje o vektorech: 30–50 českých dotazů nad
~10 dlouhými skutečnými dokumenty.

```bash
node scripts/files-eval.mjs --queries scripts/files-eval.example.json            # PGlite, bez sítě
node scripts/files-eval.mjs --queries sada.json --verbose                        # + prvních 5 pasáží dotazu
FILES_DATABASE_URL=… node scripts/files-eval.mjs --queries sada.json --db --library user_…
```

Bez `--db` si skript založí PGlite s produkčními migracemi a zaindexuje
`corpus` ze sady (DMD, vložené nebo v souborech vedle JSON; metadata z
heuristik, přepsaná polem `meta`). S `--db` hledá v dokumentech, které už v
databázi jsou (role `dawmain_app`, RLS), jen v knihovnách z `--library` —
raději lokální Postgres s kopií textů než Neon, každý běh ho probudí.

Sada je JSON `{ corpus: […], queries: […] }`. Dotaz bere `query` (nebo až 3
`queries`) a volitelně `act`, `doc_type`, `case_number`, `in_footnotes`,
`year_from`, `year_to` jako nástroj; `relevant` je seznam toho, co má dobrá
odpověď ukázat: `"klíč"` (kterákoli pasáž dokumentu), `{doc, section: "§ 2913"}`,
`{doc, page: "1245"}`, `{doc, contains: "liberační důvod"}` (podmínky se
sčítají). Úplný popis je v hlavičce skriptu, malý příklad v
`scripts/files-eval.example.json`. Recall@5 = podíl položek `relevant`, které
se objeví mezi prvními pěti pasážemi; MRR = 1 / pořadí první relevantní
pasáže. Nehodnotí se `section`, `doc` a vyřazení pasáží se shodou jen v
poznámce (`in_footnotes: false`) — ty běží až v `files.ts`.

Naměřeno: zatím nic — výsledek (datum, počet dotazů a dokumentů, obě čísla)
zapiš sem.

### Lokální vývoj

`npm test` pouští i testy SQL a RLS proti PGlite (`tests/helpers/pglite.ts`),
bez sítě a bez Neonu. Pro ruční zkoušení webu stačí lokální Postgres:
migrace přes `DATABASE_URL_UNPOOLED`, heslo pro `dawmain_app`,
`FILES_DATABASE_URL` + `FILES_MODE=on` v `.env.local`, pro návrh metadat
`AI_GATEWAY_API_KEY`. Neon dev větev nepoužívej — bere stejné CU-h i místo.
Evaluace vyhledávání (výše) běží bez databáze, na PGlite.

## Zotero — provoz

Uživatel s Pro si na webu (modál `/?zotero=1`, `app/_zdroje/zotero-modal.tsx`)
připojí svou knihovnu na zotero.org přes OAuth 1.0a; nástroje `zotero_*` pak
čtou jeho klíčem Web API v3 (`api.zotero.org`). **Jen ke čtení**: žádost o
klíč nese `write_access=0`, klíč, který přesto umí zapisovat, callback zruší
a neuloží. Jádro je v `src/zotero/*` (konstanty a limity v `config.ts`),
webová část v `src/zotero/web.ts` + tenké routy `app/api/zotero/*`, kontrakt
s modálem v `src/zotero/web-types.ts`. Rešerše k API a k cizím MCP serverům:
[docs/research/zotero.md](research/zotero.md).

**Bez konfigurace se Zotero neukazuje vůbec.** Dokud nasazení nemá
`ZOTERO_OAUTH_CLIENT_KEY`, `ZOTERO_OAUTH_CLIENT_SECRET` a `CREDENTIALS_SECRET`
(`zoteroConfigured()`), nástroje `zotero_*` se neregistrují
(`registerAllTools(server, { zotero })` v `src/mcp/tools/index.ts`), instrukce
serveru o nich mlčí (`buildInstructions(false)` v `src/mcp/server.ts`), nabídka
účtu nemá položku „Zotero“ (`app/_header.tsx` → `AccountControl zotero`)
a hlavní stránka nemá skupinu „Zotero“ pod Vlastními zdroji
(`app/page.tsx` → `ZoteroGroup` v `app/_zdroje/own-sources.tsx`; stav čte
`app/_zdroje/zotero-status.ts`, modál po odpojení skupinu obnoví),
sonda nemá kanárka a smoke podle `dawmain_ping` (`zotero: unconfigured`)
čeká 24 nástrojů místo 28. Skill volá `zotero_*` jen tam, kde je klient
v seznamu nástrojů vidí. Po nastavení proměnných (a novém nasazení) se vše
objeví samo.

### Aplikace na zotero.org a proměnné

1. Na <https://www.zotero.org/oauth/apps> zaregistrovat aplikaci „Dawmain“
   s callbackem `https://<host>/api/zotero/callback` (`CALLBACK_PATH`).
   **Neověřeno**, zda Zotero registrovaný callback vynucuje (posíláme ho v
   `oauth_callback` při každém požadavku): pokud ano, potřebuje Preview
   vlastní aplikaci nebo stabilní alias (ne adresu jednoho deploye).
2. Client Key a Client Secret do `ZOTERO_OAUTH_CLIENT_KEY` a
   `ZOTERO_OAUTH_CLIENT_SECRET`.
3. `CREDENTIALS_SECRET` — aspoň 32 znaků (`openssl rand -base64 32`);
   `src/secrets/seal.ts` z něj HKDF odvozuje klíč AES-256-GCM.

Bez kterékoli z nich (nebo bez Clerku) je Zotero vypnuté: nástroje odpoví
„není na tomto nasazení“, modál „nedostupné“. Na rozdíl od Vlastních zdrojů se
nastavuje **i na Preview** (tam běží živý checklist níže). Po změně Redeploy.

### Kde leží klíč

V Clerku, `privateMetadata.zotero` (`src/zotero/store.ts`): `{v: 1, userID,
username, sealed, fp, notes, groups, connectedAt, revokedAt}`. Klíč je
zapečetěný (AES-256-GCM, AAD `zotero:<userId>` — zkopírovaný blob nejde
otevřít pod jiným účtem), `fp` je krátký otisk klíče. Neon se nepoužívá, data
zmizí se smazáním účtu v Clerku. `updateUserMetadata` slučuje do hloubky a
**`null` maže** klíč, kam se zapíše — `zotero: null` odpojí, `null` pole
záznamu se čtou jako chybějící. Proto se záznam vždy zapisuje celý a čte
**jen přes `loadConnection`** (stavy `none` / `ok` / `revoked` /
`unreadable`), nikdy přímo z metadat; cache jen 2 s, odpojení a callback
běží na jiných instancích.

### Připojení

`POST /api/zotero/connect` (formulář; Origin, konfigurace, přihlášení, Pro,
`LIMITS.connectsPerHour` = 10) → dočasný token od zotero.org zapečetěný v
cookie `dz_zotero_oauth` (10 min, cesta jen `/api/zotero/callback`) → 303 na
zotero.org (`name=Dawmain`, `library_access=1`, `notes_access=1`,
`write_access=0`, `all_groups=read`; **nikdy `identity`**) → `GET
/api/zotero/callback` vymění token za klíč, ověří ho na `/keys/current` (týž
uživatel, osobní knihovna, nikde zápis), uloží a starý klíč zruší → 303 na
`/?zotero=1&stav=…`. `GET /api/zotero/status` vrací stav pro modál (nikdy
klíč ani otisk), `POST /api/zotero/disconnect` klíč zruší na zotero.org
(nejvýš 5 s, jinak ho uživatel smaže na zotero.org/settings/keys) a zapíše
`null`.

Hodnoty `stav`: `pripojeno`, `zamitnuto` (uživatel na zotero.org odmítl),
`vyprselo` (10 min stav, chybí cookie, připojování začal jiný účet, nebo token
nesedí), `zapis` (klíč uměl zapisovat — zrušen a odmítnut), `prihlaseni`
(nepřihlášen), `nepro`, `nedostupne`, `limit`, `chyba`.

### Šetrnost a ochrana adresy

Vlastní tenký klient (`src/zotero/http.ts`), ne `fetchUpstream`: přesměrování
ručně (klíč se nesmí poslat dál na S3), `Zotero-API-Version: 3`, poctivý UA
bez „Zotero/“ (`ZOTERO_UA`), osobní 403/404 se nepíšou do zdraví zdrojů.
Limity v `LIMITS`: nejvýš 3 souběžné požadavky na uživatele a instanci
(Zotero dovolí 5, sdílené se synchronizací desktopu), `Backoff` do 3 s
počkat, delší selhat s udaným časem, 429/503 s `Retry-After` do 5 s jeden
opakovaný pokus, 15 s na požadavek, 45 s na nástroj, JSON nejvýš 8 MB.
Hledání se necachuje; seznam skupin a kolekcí, text příloh a sken spisových
značek 10 min (klíč cache vždy s userId).

**Zotero blokuje celou IP** (429 pro všechny) po více než 5 neplatných
klíčích z ní za 300 s — a IP Vercelu sdílí všichni uživatelé. Proto:
odmítnutý klíč („Invalid key“ → `ZoteroKeyInvalidError`) si instance pamatuje
podle otisku a znovu ho nepošle; nástroj ho hned `markRevoked` označí v
Clerku (podle `fp`, takže nezruší novější klíč připojený mezitím) a další
volání skončí na bráně bez požadavku; po `breakerInvalidKeys` = 3 různých
odmítnutých klíčích se instance na `breakerMs` = 5 min od Zotera odpojí
úplně. `api.zotero.org` **nepřidávat** do `ALLOWED_FETCH_HOSTS` v
`src/mcp/tools/probe.ts`; kanárek `zotero` čte veřejné schéma bez klíče.

### PDF místo indexu

Když full-text index Zotera chybí nebo nepokrývá celý soubor, stáhne
`zotero_get_text` PDF (jen `application/pdf` s `linkMode`
`imported_file`/`imported_url`) přes `GET /items/{key}/file`: přesměrování se
následuje jednou, jen na HTTPS host S3 (`isAllowedStorageHost` — zatím
kterýkoli endpoint S3, po živém ověření zúžit na jeden) a bez hlavičky s
klíčem. Strop 25 MB (`Content-Length` i počítané bajty), převod po 300
stranách, nejvýš 2 převody na volání, 30 s. Text vytáhne převodník Vlastních
zdrojů (`src/zotero/pdf-text.ts` → `src/files/convert/pdf/*`); soubor se
neukládá, text drží cache v paměti 10 min. `Zotero-File-Compressed`, heslo/DRM,
sken bez OCR, WebDAV a odkazované soubory dostanou vlastní vysvětlení s
radou pro uživatele.

### Změna `CREDENTIALS_SECRET`

Rotace znamená, že žádný uložený klíč už nejde otevřít: připojení přejdou do
stavu `unreadable`, nástroje i modál řeknou „připojit znovu“. Staré klíče
ale **zůstanou platné na zotero.org** (bez otevřeného klíče je Dawmain
nezruší) — uživatelé si je smažou na zotero.org/settings/keys. Proto
rotovat jen při úniku.

### Živý checklist na Preview

Nasadit s proměnnými výše, `MCP_URL=… npm run smoke` a `SMOKE_LIVE=1`
(kanárek `zotero` projde). Pak se skutečným účtem Zotero (osobní knihovna +
skupina):

1. Připojit: Zotero ukáže „Dawmain“ jen ke čtení a bez identity; návrat na
   `stav=pripojeno`, v Clerku jen zapečetěný blob.
2. Na stránce Zotera povolit zápis: `stav=zapis` a klíč na
   zotero.org/settings/keys zmizí.
3. Z claude.ai s osobním OAuth: `zotero_list` ukáže knihovny a kolekce;
   `zotero_search` najde titul v osobní knihovně i ve skupině; položka
   „25 Cdo 1234/2019“ se najde dotazem „25 Cdo 1234/19“ a nabídne `ns_*`;
   slovo jen v PDF vede na automatické `everything` a shoda se seskupí pod
   dílo.
4. `zotero_get_item` ukáže poznámky a anotace.
5. `zotero_get_text`: indexované PDF stránkuje a `find` funguje; PDF nahrané
   jen přes web (neindexované) → text vytažený z PDF; PDF nad 100 stran →
   dočte i strany za limitem indexu; WebDAV nebo odkazovaný soubor →
   vysvětlení; ve Vercel logu čas a paměť převodu.
6. Smazat klíč na zotero.org: přijde právě jedna 403, připojení se označí,
   další volání skončí na bráně bez požadavku a modál hlásí „Klíč přestal
   platit“.
7. „Odpojit“: klíč zmizí na zotero.org a v Clerku je `null`.
8. Sdílený kód i účet bez Pro dostanou odmítnutí.
9. Ve Vercel logu nejsou klíče, tokeny ani verifier.

Zároveň ověřit, zda Zotero vynucuje registrovaný callback (výše).

### Fixtures k nahrazení

`tests/fixtures/zotero/*.json` jsou **ručně sestavené z dokumentace** (z
vývojového kontejneru nebyl api.zotero.org dostupný). Na Preview je nahradit
živými záchyty (klíče a tokeny vymazat): `keys-current*.json` (přesný tvar
`access.groups`), `items-search.json`, `collections.json`, `groups.json`,
`fulltext-*.json` (oddělovače stran, `indexedPages`/`totalPages`), a zapsat
tělo 403 „Invalid key“ a host přesměrování `/file` (pak zúžit
`isAllowedStorageHost`). Totéž připomínají hlavičky
`tests/zotero-client.test.ts`, `tests/zotero-oauth.test.ts` a
`tests/zotero-routes.test.ts`.

## Přidání zdroje

1. `src/sources/<zdroj>.ts` — klient s odděleným `fetchX`/`parseX`.
2. `src/mcp/tools/<zdroj>.ts` — `register<Zdroj>(server)`.
3. Řádka v `src/mcp/tools/index.ts`, kanárek do `src/mcp/tools/probe.ts`,
   testy do `tests/`, jméno nástroje do `EXPECTED_TOOLS` v `scripts/smoke.mjs`.
4. Pokud se zdroj má objevit na stránce se semaforem, řádka do `DATABASES`
   v `src/mcp/status.ts` — stránka i její fallback čtou ten samý seznam.
5. Anotace, `isoDate`, `find`/stránkovací popisy a `fail()` ber
   z `src/mcp/tools/shared.ts`, nekopíruj je.
