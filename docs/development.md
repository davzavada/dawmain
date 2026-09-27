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
2. Spusť smoke proti nasazení (viz výše), pak `SMOKE_LIVE=1`.
3. Zavolej `dawmain_probe_sources` — ověří všechny upstreamy z nasazení.
4. `dawmain_probe_sources {discover: true}` vypíše skutečná pole formuláře
   NSS — slouží k doladění mapování v `src/sources/nss.ts`.
5. `dawmain_probe_sources {include_raw: true, sources: ["ns"]}` zachytí syrové
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
AI Gateway) a po potvrzení v nich hledají nástroje `files_*`. Originály se
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
dalšího). Po změně Redeploy.

| Proměnná | Význam | Výchozí |
| --- | --- | --- |
| `FILES_MODE` | hlavní vypínač: `on`, `readonly` (hledání, čtení a mazání, bez nahrávání), `off` | `off` |
| `FILES_DATABASE_URL` | pooled URL role `dawmain_app`; bez ní `unconfigured` | — |
| `DATABASE_URL_UNPOOLED` | vlastnické přímé připojení, jen pro `scripts/db-migrate.mjs` z terminálu; aplikace ho nečte | — |
| `FILES_META_MODEL` | model pro návrh metadat přes AI Gateway | `google/gemini-2.5-flash-lite` |
| `FILES_GLOBAL_MAX_PAGES` | strop stran pro celou instalaci | 30 000 |
| `FILES_PERSONAL_PAGES` | kvóta osobní knihovny (stran) | 3 000 |
| `FILES_TEAM_PAGES` | kvóta týmové knihovny (stran) | 10 000 |
| `FILES_OPERATOR_IDS` | Clerk `user_…` oddělená čárkou — přístup na `/vlastni-zdroje/provoz` | — |
| `FILES_AI_BUDGET_USD` | klouzavý 30denní rozpočet AI v celých USD; nad ním jen heuristiky | 4 |
| `CLERK_WEBHOOK_SIGNING_SECRET` | podpisový klíč webhooku Clerku (`whsec_…`) | — |
| `CRON_SECRET` | Vercel ho posílá cronu jako `Authorization: Bearer …`; bez něj cron odmítne všechno | — |

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
   asistent v knihovně přestane hledat, uživatel ji 90 dní vidí a může mazat,
   pak se smaže. **Před smazáním mu napiš** (slibují to zásady ochrany
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

- **Automaticky** (`src/files/guards.ts`, cache 30 s): velikost DB ≥ 80 %
  z 400 MB nebo součet stran ≥ 80 % z `FILES_GLOBAL_MAX_PAGES` → jen pro
  čtení; odhad CU-h ≥ 70 % ze 100 → jen pro čtení, ≥ 90 % → vypnuto. Jen pro
  čtení = hledání, čtení a mazání jdou, nahrávání ne.
- **Odhad CU-h**: Neon Free nemá API spotřeby, aplikace si proto zapisuje
  každou minutu, kdy sáhla do DB (`db_activity`), a počítá sjednocení
  intervalů [minuta, minuta + 5 min] × 0,25 CU. Každé probuzení stojí aspoň
  5 minut — i proto nástroje nesahají do DB kvůli volajícím bez Pro.
- **Vypínač**: přepínač režimu na stránce provozu (`system_state`, bez
  redeploye, projeví se do 30 s), nebo `FILES_MODE=off` + Redeploy.
- Pool: `connectionTimeoutMillis` 4 s, `statement_timeout` 10 s (ingest 60 s)
  — uspaný Neon dá rychlou odpověď „dočasně nedostupné“, ne 60 s čekání.
- Denní cron (`/api/cron/files`, 03:00 UTC; Hobby smí jednou denně s
  přesností na hodinu): výmaz knihoven po lhůtě, kontrola Pro, restart
  zaseknutých zpracování, pojistky, velikost DB.

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
dávkách tlačítkem „Přeindexovat dávku“ na stránce provozu, nikdy celý korpus
při DB nad 60 %.

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
(velikost DB, strany, odhad CU-h, rozpočet AI, nahrání za měsíc), knihovny,
zaseknuté dokumenty, přepínač režimu a „Přeindexovat dávku“ (≤ 200 dokumentů
z uloženého textu na kliknutí).

### Nezákonný obsah

Podmínky slibují postup pro oznámení (DSA čl. 16): ověř oznámení, dokument
smaž a jeho obsah zablokuj, aby nešel nahrát znovu, a nahrávajícímu pošli
odůvodnění (DSA čl. 17). Blokace podle hashe textu (SQL jako vlastník):

```sql
INSERT INTO blocked_content (content_sha256, reason)
SELECT content_sha256, 'oznámení z <datum>' FROM documents WHERE id = '<uuid>'
ON CONFLICT DO NOTHING;
```

Smaže-li dokument vlastník SQL příkazem (`DELETE FROM documents …`), počítadla
stran knihovny se nesníží — uprav `libraries.page_count` a `doc_count` ručně.

### Právní texty

Sliby v `/soukromi` a `/podminky` visí na konkrétních hodnotách — když se
změní, změň i text, zvedni `EFFECTIVE` v `app/_legal.tsx` a napiš uživatelům
měsíc předem (podmínky to slibují):

- zpracovatelé: Clerk, Vercel (+ Google přes AI Gateway), Neon — jiný model
  nebo nová služba = nový subdodavatel;
- výmaz knihovny 7 dní po smazání účtu/týmu (+ nejvýš den do cronu → text
  říká „do 8 dnů“), 90 dní po odebrání Pro, 6 h historie Neonu;
- region Frankfurt u Vercelu i Neonu, rozsah textu k návrhu metadat
  (~16 000 znaků), cookies Clerku.

### Lokální vývoj

`npm test` pouští i testy SQL a RLS proti PGlite (`tests/helpers/pglite.ts`),
bez sítě a bez Neonu. Pro ruční zkoušení webu stačí lokální Postgres:
migrace přes `DATABASE_URL_UNPOOLED`, heslo pro `dawmain_app`,
`FILES_DATABASE_URL` + `FILES_MODE=on` v `.env.local`, pro návrh metadat
`AI_GATEWAY_API_KEY`. Neon dev větev nepoužívej — bere stejné CU-h i místo.

## Přidání zdroje

1. `src/sources/<zdroj>.ts` — klient s odděleným `fetchX`/`parseX`.
2. `src/mcp/tools/<zdroj>.ts` — `register<Zdroj>(server)`.
3. Řádka v `src/mcp/tools/index.ts`, kanárek do `src/mcp/tools/probe.ts`,
   testy do `tests/`, jméno nástroje do `EXPECTED_TOOLS` v `scripts/smoke.mjs`.
4. Pokud se zdroj má objevit na stránce se semaforem, řádka do `DATABASES`
   v `src/mcp/status.ts` — stránka i její fallback čtou ten samý seznam.
5. Anotace, `isoDate`, `find`/stránkovací popisy a `fail()` ber
   z `src/mcp/tools/shared.ts`, nekopíruj je.
