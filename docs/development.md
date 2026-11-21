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
| `us_search` / `us_get_decision` | nalus.usoud.cz | judikatura ÚS: fulltext (vč. zóny disentů a řazení dle významu; `§` se z dotazu vypouští), citace/ECLI, populární název, napadený akt (číslo/název/ust. — abstraktní přezkum bez klíčových slov), dotčený orgán, jen publikovaná, datum rozhodnutí i zpřístupnění; každý hit nese soudce zpravodaje. Číselníkové filtry NALUS (`judge`, `dissenting_judge`, `outcome`, `petitioner`, `contested_organ_type`, `contested_act_kind`) NALUS ignoruje (readonly pickery z popupu, bez zachyceného toku nejdou přehrát) — `us_search` je proto odmítá s `INPUT_INVALID` dřív, než pošle request, místo aby nefiltrovaný seznam vydával za filtrovaný |
| `caselaw_search` | NSS + NS + ÚS | jeden dotaz paralelně přes tři vrcholné soudy; varianty round-robin s počty za variantu, každá varianta s vlastním limitem (pomalá shodí jen sebe); dráha NSS jen NSS (krajské soudy přes `include_regional`), ÚS podle relevance, hit nese soud |
| `justice_search` / `justice_get_decision` | rozhodnuti.justice.cz | obecné soudy (okresní/krajské/vrchní): fulltext (`match` všechna slova/jedno ze slov/fráze), spisová značka, kódy soudů, druh rozhodnutí, datum vydání i zveřejnění, aplikovaný předpis a § (`applies_act` + `applies_section`) — vše server-side přes `/api/finaldoc`, backend SPA zachycený z živého požadavku; hit nese i `affects` (co rozhodnutí udělalo s rozhodnutím nižšího soudu: CHANGE/CONFIRM/CANCEL…) |
| `sdeu_search` / `sdeu_get_document` | InfoCuria + Cellar | FULLTEXT judikatury SDEU (C i T) přes vlastní index soudu — hledá napříč všemi jazykovými verzemi; typ dokumentu, stav věci, citovaný předpis a článek (`cites_celex`/`cites_article`), předběžné otázky podle předkládajícího státu (`referred_from`), datumy — vše server-side dle zachyceného payloadu SPA | 
| `eurlex_search` / `eurlex_get_document` | Cellar SPARQL (Publications Office) | EU legislativa, judikatura i legislativní materiály (návrhy COM, sdělení, zelené/bílé knihy, SWD, impact assessmenty, stanoviska EHSV/VR, postoje EP a Rady) dle názvů, CELEX/ECLI, typů a dat; texty z oficiálního Cellaru |
| `psp_search` | www.psp.cz | sněmovní tisky přes vlastní formulář Sněmovny (`tisky.sqw`, GET, zachycený HAR 2026-10): název tisku (`na` — filtr webu, ne fulltext textů), číslo tisku (`tqb25`), druh tisku (`types` → zaškrtávátka `tqa27…`), jen neukončené (`tqa17`), a hledání podle čísla Sbírky (`act: "221/2006"` → záložka návrhů zákonů, `tqb18`/`tqb19`) — to jediné prokazatelně odpovídá napříč obdobími (živě: o=9, výsledek tisk 1110/4); `period` nebo `year` (ve volebním roce obě období) určí, v kterém období se formulář otevře a která období se v odpovědi nechají (ostatní se spočítají); `ra=100` řádků na požadavek, celkový počet z řádku „Celkem nalezen N tisk“, další stránky jen podle odkazů, které výpis tiskne (markup stránkování nezachycen), nejvýš 6; hit nese číslo, období z odkazu řádku, název a ostatní buňky (druh, stav / číslo Sb.) |
| `psp_get_tisk` | www.psp.cz | jeden tisk (`historie.sqw?o=&t=`, zachyceno 50/10): název, „Stav projednávání ke dni“, schéma legislativního procesu v jednom řádku (✓ hotovo, ▶ aktuální fáze), text sekcí (Předkladatel, Poslanecká sněmovna, Vláda, Senát…) s daty, odkaz „Navržené změny předpisů“ a dokumenty z odkazů stránky — části tisku (`tiskt.sqw?O=&CT=&CT1=`, popsané větou, která je v průběhu jmenuje), stanovisko Parlamentního institutu (`text2.sqw?idd=`), usnesení výborů (`tiskt.sqw?v=ORGV&ct=` — není částí tisku, jen odkaz), každý s druhem podle slov popisku a s voláním `psp_get_text` |
| `psp_get_text` | www.psp.cz | text části tisku (`period` + `number` + `part`) nebo souboru (`document_id`). psp.cz text do stránky `tiskt.sqw` nevkládá (zachyceno u 50/10, 362/6 i 1110/4): stránka nese jen `#main-content` s nadpisem, box „Celý sněmovní tisk“ / „Verze PDF“ / „Originál dokumentu“ a tabulku souborů seskupenou nadpisy („Návrh zákona včetně důvodové zprávy“, „Platné znění s vyznačením změn“; PDF i DOCX). U části proto nástroj sám vybere hlavní soubor (`mainDocument`: první skupina, DOCX před PDF; bez skupin celý tisk, PDF rendice před originálem), přečte ho a ostatní soubory vypíše s `document_id`. Formát podle prvních bajtů — PDF přes převodník Vlastních zdrojů (`pdfText` s `maxTotalPages` 5 000, 60 stran na volání, `pdf_pages` pro další), DOCX přes mammoth, HTML jako text; starý `.doc` se znovu stáhne jako `&pdf=1`; stránky 45k znaků, `find` |
| `sk_predpis_search` | Slov-Lex (Zbierka zákonov SR) | fulltext, název, číslo („40/1964“), ročník, typ, účinnost k datu a datum vyhlášení přes Solr `GET /vyhladavanie/predpisZbierky/rozsirene` (`text`, `nazov`, `cislo`, `rocnik`, `typPredp_value`, `ucinnyK`, `vyhlaseny_*`, `rows`/`start`, `sort`); najde předpisy, ne paragrafy; hit nese až 3 nadpisy s termíny dotazu |
| `sk_predpis_get_act` | Slov-Lex (Zbierka zákonov SR) | citace, název a historie znění ze statické stránky `static.slov-lex.sk/static/SK/ZZ/{rok}/{číslo}/` (řádky `tr.effectivenessHistoryItem`: vyhlásené, účinnost od–do, novely); vyznačí znění účinné k `date` a budoucí |
| `sk_predpis_get_text` | Slov-Lex (Zbierka zákonov SR) | jeden §, jeden čl. nebo celý předpis po stránkách ze statického `{YYYYMMDD}.html` (`0000-00-00` = vyhlásené znenie); jednotky `div.paragraf`/`div.clanok` mimo `.citat` (citované nové znění novely), takže u novely `§ N` → `NOT_FOUND` s nápovědou číst po `čl.` |
| `sk_lp_search` | Slov-Lex (eLegislatíva) | legislativní procesy (`POST /internal/elegislativa/legislativne-materialy/filter`, `hladanyVyraz`); číslo „LP/2025/300“ rovnou na detail |
| `sk_lp_get_process` | Slov-Lex (eLegislatíva) | detail LP, štádiá s daty (`/historia`), MPK, výsledek v NR SR, novelizované předpisy, „Vyhlásené ako … Z. z.“ a soubory štádia s `document_id` |
| `sk_lp_get_text` | Slov-Lex (eLegislatíva) | soubor LP (`sprievodne-dokumenty/{uuid}/download`, DOCX/PDF přes sdílené `extractDocument`), nebo s `year`+`number` dôvodová správa posledního štádia; `find`, `pdf_pages`, stránky |
| `sk_judikatura_search` | Slov-Lex (súdne rozhodnutia) | `database: "sudy"` = všeobecné súdy vč. NS SR a NSS SR (`GET /vseobecne/filter`, vždy podle data, nejnovější první; soud, sp. zn., ECLI, data, forma, povaha, oblast, odkazovaný předpis), `"judikaty"` = Zbierka stanovísk a rozhodnutí (`POST /judikaty/filter`) |
| `sk_judikatura_get_decision` | Slov-Lex (súdne rozhodnutia) | rozhodnutí všeobecného súdu (`uuid:uuid`; hlavička z detailu, text z PDF na `obcan.justice.sk`) nebo judikát (prosté uuid; `secHtml` s právnou vetou); `find`, stránky, `pdf_pages` |
| `eurlex_get_history` | Cellar SPARQL (Publications Office) | travaux préparatoires aktu z dossieru interinstitucionálního postupu (`cdm:dossier_contains_work` — obsahuje i přijatý akt, takže kotví CELEX aktu i kteréhokoli dokumentu postupu, případně číslo postupu `2012/0011(COD)`); vrací návrh s důvodovou zprávou, impact assessmenty, stanoviska, postoje EP/Rady + číslo postupu, právní základ a stav (přijato/projednáváno/staženo) |
| `doctrine_search` | cuni.primo.exlibrisgroup.com | doktrína: knihy, kapitoly a články z UKAŽ Univerzity Karlovy (Primo VE: katalog UK + Central Discovery Index licencovaných e-zdrojů); `query`/`queries` (≤ 3 varianty), `title`, `author`, `subject`, `language`, `year_from`/`year_to`; katalog stránkuje po 10, `limit` (≤ 20; nad 10 záznamy stručně, bez abstraktů) stáhne víc stránek v paralelní dávce a `page` kráčí dál (`total` = `total_local` + `total_central`) — vrací bibliografické záznamy s odkazem na záznam, abstraktem/obsahem a přístupovými odkazy, žádné plné texty; klient postavený na zachyceném požadavku SPA (HAR 2026-09), ověřený živě z produkce |
| `doctrine_get_record` | cuni.primo.exlibrisgroup.com | jeden záznam v plném znění přes full-display endpoint Prima (ověřený živě): celý abstrakt, obsah (TOC), hesla, identifikátory a přístupové odkazy — hledání ukazuje jen začátek abstraktu a obsahu; text díla se nestahuje (k němu vede odkaz na záznam, licencované tituly si čtenář otevře sám přes vzdálený přístup UK) |
| `files_search` | Vlastní zdroje (Postgres) | hledání ve vlastních dokumentech uživatele s Pro (osobní knihovna): český fulltext (Snowball stemmer v aplikaci; váhy vlastní nadpis › nadřazený nadpis › tělo › poznámky pod čarou), identifikátory (sp. zn. i s krátkým rokem, §, předpisy i zkratkami „o. z.“/„OSŘ“, ISBN, DOI, ECLI) a metadata — kanály sloučené přes RRF se stropem shod na dokument už v SQL; filtry typu dokumentu, roku, předpisu, § / článku, sp. zn., jednoho dokumentu a jen poznámek (§ a sp. zn. se uplatní v SQL před stropem); hit nese cestu oddíly, pinpoint (s., § + m. č., pozn.), výřez se zvýrazněním a pro každou sp. zn. řádek „oficiální text:“ s voláním `ns_search`/`nss_search`/`us_search`/`sdeu_search` |
| `files_get_document` | Vlastní zdroje (Postgres) | čtení vlastního dokumentu: u dokumentu nad ~30 stran bez cíle osnova (`toc`), jinak `section` (§, článek, kapitola), `mn` (marginální číslo, i rozsah), `at` (tištěná strana), `footnote`, `find`; okna ≤ 45 000 znaků zarovnaná na celé strany, hlavička „VLASTNÍ DOKUMENT“ s citací ČSN ISO 690, pokračování omezené na zvolený úsek, denní limit čtení na dokument (proti vysávání celých knih) |
| `files_list` | Vlastní zdroje (Postgres) | knihovny uživatele a jejich dokumenty (stav, typ, strany, co čeká na potvrzení metadat) a odkaz na nahrávání |
| `zotero_search` | Zotero (api.zotero.org, klíč uživatele) | hledání v připojené knihovně Zotero, jen ke čtení: `mode` `title` (názvy, autoři, roky) / `everything` (všechna pole, poznámky, full-text index příloh), prázdné `title` se samo zopakuje v `everything`; `query`/`queries` (≤ 3 varianty round-robin), `library` (výchozí osobní + skupiny, nejvýš 6), `collection`, `tags` (všechny), `item_type`, `sort`, `limit` (≤ 50 na knihovnu), `page`; shody v přílohách, poznámkách a anotacích seskupené pod dílo; sp. zn. v dotazu navíc projde nejnovější položky `case` (Zotero `q` do `docketNumber` nevidí) a řekne, kolik jich prošla; řazení není podle relevance |
| `zotero_get_item` | Zotero | jedna položka celá: pole po oddílech, abstrakt, extra, štítky, kolekce, poznámky jako text, přílohy (každá s voláním `zotero_get_text`) a anotace prvních PDF; u rozhodnutí řádek „oficiální text:“ |
| `zotero_get_text` | Zotero | text přílohy: full-text index Zotera, když pokrývá celý soubor; jinak PDF ze Zotero Storage přes převodník Vlastních zdrojů (jen v paměti, 10 min); jinak částečný index s varováním nebo důvod, proč text není (neindexováno, WebDAV, odkazovaný soubor, sken, heslo) a co s tím; stránky ~45k znaků, `find` |
| `zotero_list` | Zotero | knihovny (osobní + skupiny klíče), kolekce a štítky; `query`, `limit` (≤ 100), `page` |
| `dawmain_ping` | — | které nasazení odpovědělo |
| `dawmain_probe_sources` | — | diagnostika všech upstreamů z nasazeného serveru; `include_raw` pro záchyt fixtures, `discover` pro hledání neověřených endpointů |
| `dawmain_guide` | — | rešeršní návod (`skills/dawmain-reserse/SKILL.md` bez front matter) v jedné odpovědi, přizpůsobený volajícímu (`tailorManual`: sekce zdrojů, které účet nemá — Vlastní soubory, Zotero, UKAŽ — se vynechají a poznámka pod nadpisem říká jejich nástroje nevolat; pravidla jsou táž jako v branách nástrojů, při výpadku Clerku se nevynechá nic), čtený ze stromu repa za běhu (`outputFileTracingIncludes` v `next.config.ts` ho přibalí do standalone buildu); instrukce serveru říkají modelu zavolat ho jednou na začátku každé rešerše — skill v claude.ai tak nikdo instalovat nemusí a každá konverzace čte nasazenou verzi; test hlídá velikost pod `SKILL_MAX_CHARS` |

Nástroje `files_*` sáhnou do databáze až po třech kontrolách, které se jí
nedotknou, v tomto pořadí: režim z env (`FILES_MODE`) → přihlášení OAuth
(sdílený kód ani anonym nemají uživatele) → knihovna s Pro u Clerku. Kdo
neprojde, dostane jednu chybovou odpověď s pokynem `files_*` v konverzaci
znovu nevolat — databáze se tak nezatěžuje kvůli volajícím, kteří Vlastní
zdroje nemají. Veškerý text z dokumentů (i názvy, nadpisy a autoři) jde do plotu
`⟦DOC nonce⟧ … ⟦/DOC nonce⟧` s náhodným nonce na každou odpověď — pro model
data, ne instrukce; nápovědy nástroje jsou až za plotem. Limit 60 volání za
hodinu na uživatele.

Nástroje `zotero_*` pošlou první požadavek na Zotero až po pěti krocích brány
(`zoteroGate` v `src/mcp/tools/zotero.ts`): nasazení má OAuth aplikaci,
`CREDENTIALS_SECRET` i Clerk (`zoteroConfigured`) → osobní přihlášení OAuth
s Pro (`personalProCaller`, stejný nárok jako `files_*`, ale **bez** vypínačů
`FILES_MODE` — Zotero databázi nepotřebuje) → vlastní hodinový limit
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
**Poslanecká sněmovna** (`psp_*`, 2026-10): psp.cz není z vývojového sandboxu
dosažitelný (proxy host odmítá); všechny stránky, na kterých klient stojí,
jsou ale **zachycené z prohlížeče (HAR) a leží ve `tests/fixtures/psp/`**:
vstup formuláře `sntisk.sqw?o=10`, výsledky `tisky.sqw` (jeden hit podle
čísla Sbírky, prázdný výsledek, 2. strana hledání `na=zakon` s 1 856 hity a
stránkováním `str=` v `p.paging`), `historie.sqw?o=10&t=50` a `tiskt.sqw` tří
tisků (50/10, 362/6, 1110/4). Z nich: formulář má pole `na`, `tqb25`/`tqb26`,
`tqa27–35/62–64`, `tqa17`, `ra`, záložka návrhů zákonů `tqb18`/`tqb19` (číslo
Sbírky, odpovídá napříč obdobími); `na` je filtr názvu bez diakritiky
(„zakon“ našel i „zákoník“); řádek výsledků nese podčíslo (11/0 a stanovisko
vlády 11/1 zvlášť); stránky chodí jako `charset=Windows-1250` s obsahem v
`#main-content`; **`tiskt.sqw` text nikdy nenese**, jen soubory — proto
`psp_get_text` u části čte hlavní soubor sám. Po nasazení stačí
`dawmain_probe_sources {sources: ["psp"]}` a živý průchod
`psp_search {act: "89/2012"}` → `psp_get_tisk` → `psp_get_text` (ověří
převod PDF/DOCX, který se ze záchytů ověřit nedá). Otevřená data Sněmovny
(`hp.sqw?k=1300`, ZIP celé databáze) se záměrně nestahují — žádný dotaz nemá
stahovat celou databázi. Senát (senat.cz) ani eKLEP pokryté nejsou.
**Slovensko** (`sk_*`, 2026-11): Slov-Lex čte veřejnou bránu
`api-gateway.slov-lex.sk` bez klíče, texty předpisů jsou statické HTML na
`static.slov-lex.sk`, PDF rozhodnutí leží na `obcan.justice.sk`. Spring vrací
při chybějícím povinném parametru **401** (přesměrování na zabezpečené
`/error`), ne 400 — klient to hlásí jako `PARSE_DRIFT`, nikdy jako výpadek;
proto `vseobecne/filter` vždy nese i prázdné `query=&ecli=&spisovaZnacka=…`.
Převod DOCX/PDF je společný s psp.cz (`src/sources/shared/documents.ts`,
`extractDocument`). Živě (17. 11. 2026) ověřeny endpointy a záchyty v
`tests/fixtures/slovlex/` (popis v `docs/research/slovlex.md`, plán v
`docs/research/slovlex-plan.md`); canary `slovlex-zbierka`, `slovlex-static`,
`slovlex-lp`, `slovlex-sudy`. Ústavný súd SR je na Slov-Lexu jen ve sbírce judikátů (`sud: "USSR"`, 1993–2014); novější pokryté nejsou.
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
                            v prohlížeči; originál se pak nahraje zvlášť
                            (po 8 MB částech, jen ke stažení, asistent ho nečte)
src/files/text/             český stemmer (vendorovaný Snowball 3.1.1), tokeny,
                            stavba tsquery jen ze sanitizovaných slov
src/files/index/            chunky, tsvector, identifikátory a zkratky předpisů,
                            zvýraznění
src/files/meta/             návrh metadat: heuristiky (nic neodchází mimo server)
src/files/db/               withScope (transakce + RLS), repozitáře, migrace
                            v čistém SQL (migrations/)
src/files/access.ts         Clerk → osobní knihovna, Pro, kvóta
src/files/guards.ts         režim (env, přepínač provozovatele, pojistky free
                            tieru) a rate limit
src/files/upload.ts         nahrání: kontroly, rezervace kvóty, zápis textu
src/files/ingest.ts         zpracování po nahrání (after(), lease v řádku DB)
app/vlastni-zdroje/         vstup do Vlastních zdrojů na webu (modální okno nad
                            stránkou, /?zdroje=moje); provoz/ = stránka provozovatele
app/api/files/…             nahrání, stav zpracování, souhrn, dokumenty
app/api/webhooks/clerk/     smazání účtu (i dřívějšího týmu) → výmaz knihovny po 7 dnech
app/api/cron/files/         denní úklid a pojistky (dawmain-cron.timer, 04:00)
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
ověření se dělá **proti běžící instanci**. Produkce přijímá jen přihlášení
účtem (OAuth přes Clerk), takže smoke s přístupovým kódem jde jen proti
instanci, která `MCP_BEARER_TOKEN` zná — lokálně, nebo proti kandidátovi
vydání, kterého `deploy.sh` pouští na vedlejším portu:

```bash
MCP_URL=http://127.0.0.1:3000/api/mcp MCP_BEARER_TOKEN=… npm run smoke
MCP_URL=… MCP_BEARER_TOKEN=… SMOKE_LIVE=1 npm run smoke   # + reálné dotazy do zdrojů
```

Bez `MCP_BEARER_TOKEN` smoke ověří aspoň to, že anonymní požadavek dostane
401, a OAuth discovery.

## Nasazení

Produkce běží jen na vlastním serveru (Proxmox, LXC `web`, služba systemd,
standalone build Next.js) za Cloudflare (DNS proxy + Cloudflare Tunnel).
Kontejnery, síť, databáze a zálohy popisuje
[infra/proxmox.md](infra/proxmox.md), soubory nasazení jsou v `deploy/web/`;
historii přesunu z Vercelu a Neonu (16. 11. 2026) zachycuje
[infra/migrace-z-vercelu.md](infra/migrace-z-vercelu.md). Node ≥ 22
(`engines` v `package.json`).

- **Nastavení** `/etc/dawmain/env` (proměnné ze sekce „Server“ v
  `.env.example` a produkční klíče). `NEXT_PUBLIC_*` se čtou při buildu,
  ostatní při startu služby.
- **Proměnné běhu** (`src/runtime.ts`): `PUBLIC_URL` (adresa na úvodní
  stránce, v odkazu na nahrávání a v OAuth discovery), `APP_ENV`,
  `APP_REGION`, `GIT_SHA` (ukazuje `dawmain_ping`; `region: home`).
- `DAWMAIN_REQUIRE_AUTH=1` — endpoint odmítne anonymní požadavky i bez tokenu
  a bez Clerku. Fail-closed: vypíná jen `0` / `false` / `off` / `no`; když
  chybí, vyžaduje přihlášení každý produkční server (`NODE_ENV=production`),
  `npm run dev` zůstává anonymní.
- `TRUST_FORWARDED_HOST` — výchozí stav je **nevěřit** `X-Forwarded-Host` a
  `-Proto`, které může poslat kdokoli (Cloudflare Tunnel předává veřejný
  `Host` sám); OAuth discovery nabízí `PUBLIC_URL`. Unit pevně nastavuje `0`;
  `1` jen za proxy, která ty hlavičky přepisuje.
- **Nasazení** (`deploy/web/deploy.sh`, jako `dawmain`): `NEXT_OUTPUT=standalone`
  (samostatný `server.js`), `NEXT_DEPLOYMENT_ID` (verze vydání); sestaví
  vydání, na vedlejším portu ověří 401 bez tokenu a smoke test a teprve pak
  přepne `current`; když se služba po restartu nezvedne, vrátí předchozí
  vydání. Uživatel `dawmain` k tomu potřebuje jediné právo:
  `dawmain ALL=(root) NOPASSWD: /bin/systemctl restart dawmain-web`
  (soubor v `/etc/sudoers.d/`). Po změně unit souborů je zkopírovat do
  `/etc/systemd/system/` a `systemctl daemon-reload`.
- **Denní údržba** Vlastních zdrojů: `deploy/web/dawmain-cron.timer` volá
  `/api/cron/files` s `CRON_SECRET`.
- **Záloha databáze**: `deploy/web/backup-files.sh` + `dawmain-backup.timer`
  jsou připravené, ale zatím vypnuté — záloha mimo stroj neběží.
- `deploy/web/migrace/` jsou jednorázové nástroje přesunu (už se nespouštějí).

Po nasazení:

1. `dawmain_ping` (region, commit, `auth: oauth`).
2. Zavolej `dawmain_probe_sources` — ověří všechny upstreamy ze serveru.
3. `dawmain_probe_sources {discover: true}` vypíše skutečná pole formuláře
   NSS — slouží k doladění mapování v `src/sources/nss.ts`.
4. `dawmain_probe_sources {include_raw: true, sources: ["ns"]}` zachytí syrové
   tělo odpovědi jako podklad pro fixture (po jednom zdroji — všechny naráz se
   nevejdou do rozpočtu odpovědi).

## Připojení klienta

S OAuth (Clerk) stačí URL — klient si při prvním použití řekne o přihlášení
(`/mcp` → authenticate v Claude Code, v claude.ai se okno otevře samo):

```bash
claude mcp add --transport http dawmain https://dawmain.davidzavada.cz/api/mcp
```

S přístupovým kódem — jen proti instanci, která `MCP_BEARER_TOKEN` zná
(lokální vývoj, smoke testy); produkce ho nepřijímá:

```bash
claude mcp add --transport http dawmain http://127.0.0.1:3000/api/mcp --header "Authorization: Bearer <token>"
```

```json
{
  "mcpServers": {
    "dawmain": {
      "type": "http",
      "url": "http://127.0.0.1:3000/api/mcp",
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

Model ho dostane od konektoru samotného: instrukce serveru (ty čte na
začátku každé konverzace se zapnutým konektorem, stejně jako popisy
nástrojů) nesou spouštěcí fráze ze skillu a pokyn zavolat `dawmain_guide`
jednou před první rešerší; nástroj vrátí návod (celý ~57 tis. znaků, ~15
tis. tokenů — zhruba jedna stránka rozsudku) ve verzi, která je nasazená.
Účet bez Vlastních souborů, Zotera a UKAŽ — tedy většina — dostane návod
bez jejich tří sekcí (~43 tis. znaků) s poznámkou tyto nástroje nevolat:
celý návod mu jinak v prvním kole každé rešerše ukládal tři volání
(`files_search`, `zotero_search`, `doctrine_search`), která mohla odpovědět
jen „pro tento účet není“. Stažený skill (`/dawmain-reserse.md`) zůstává celý.
Nic se neinstaluje a nic nezastarává; merge do main = aktualizovaný návod
pro všechny. Soubor se do standalone buildu dostane přes `outputFileTracingIncludes`
(route `/dawmain-reserse.md` pro stažení ho čte při buildu, nástroj za běhu).

Ruční instalace v claude.ai (Nastavení → Capabilities → Skills, nahrát
adresář) dál funguje jako volitelný spouštěč, nic na ní ale nezávisí; kdo ji
má, nese si vlastní kopii, kterou musí sám obnovovat.

## Výkon a šetrnost ke zdrojům

- Neměnná data se cachují per warm instance: metadata a historie znění
  e-Sbírky (10 min), NSS handshake (10 min), texty dokumentů (10 min)
  a výsledky hledání (5 min).
- NALUS: stav formuláře (`__VIEWSTATE` a spol.) se drží 10 min a sdílí ho
  všechna hledání instance. Živě ověřeno (2026-11): jeden stav odpoví na
  libovolný počet POSTů s kritérii — souběžně, bez cookie z GETu formuláře
  i po 11 minutách — a session otevře NALUS až na POSTu. Hledání tak stojí
  POST + výsledky místo formulář + POST + výsledky (měřeno 1,7 s místo
  4,6 s) a tři varianty na studené instanci sdílí jeden GET formuláře.
  Odpověď 200 (nula shod) nebo HTTP chyba na stavu, který si volání samo
  nenačetlo, se nejdřív zopakuje na čerstvém formuláři; teprve ta druhá se
  hlásí.
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
- Timeouty: výchozí 15 s/request; odchylky: NSS POST 25 s, psp.cz soubor 25 s, Cellar retrieval 25 s,
  Cellar SPARQL 30 s, justice.cz hledání 45 s, e-Sbírka SPARQL 20 s, katalogy
  doktríny 20 s.
- Délka volání: každé volání nástroje má strop 60 s (pro něj byly nástroje
  postavené na Vercelu a zůstává; Cloudflare před serverem ukončí každý
  požadavek po 100 s). Odpověď nástroje má přijít dřív, než to klient vzdá,
  pomalé zdroje proto mají timeouty pod touto hranicí. Celé volání nástroje
  hlídá `CALL_BUDGET_MS` = 54 s od příchodu requestu (hodiny
  `runWithCallClock` v route, `src/sources/shared/clock.ts`): po něm registr
  odpoví textovou chybou místo useknutého streamu. Rozpočty jednotlivých
  zdrojů (NS/NALUS náhledy, Cellar) se počítají přes
  `callDeadline` a končí nejpozději 3 s před touto hranicí, aby jejich
  částečné výsledky a nápovědy stihly odejít. Nahrání a zpracování dokumentu
  Vlastních zdrojů běží v `after()` po odpovědi a žádný strop serveru nemá.
  (Exporty `maxDuration` z rout zmizely: byly to nastavení Vercelu,
  standalone server je nečte.)

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
   (`verifyClerkToken`), k čemuž potřebuje secret key. MCP route ověřuje
   token sama — `authenticateRequest` přes `clerkClient()` v
   `src/mcp/auth.ts`, ne přes `auth()` z middlewaru — takže na `proxy.ts`
   nezávisí. `proxy.ts` (Clerk middleware na stránkách, `/api` a `/__clerk`;
   bez `protect()`, takže nic nezamyká) slouží stránkám (nabídka účtu); bez
   klíčů je no-op. Přijatý token se pamatuje 60 s na instanci (podle
   SHA-256, jen přijetí, nikdy odmítnutí): token Clerku je neprůhledný a
   jeho ověření je dotaz na backend API Clerku, který by bezstavový
   transport platil u každého HTTP požadavku (initialize, tools/list, každé
   tools/call). Odvolaný nebo propadlý token tak platí nejvýš o minutu déle
   — stejnou minutu, po kterou se cachuje přístup účtu.
2. **Sdílený přístupový kód** (`MCP_BEARER_TOKEN`) — původní schéma. Produkce
   ho nenastavuje (přihlášení jen účtem); zůstává pro lokální vývoj a smoke
   testy. Token se přijímá z `Authorization`, `X-API-Key` i
   `cf-aig-authorization` (stačí, když sedí kterákoli).

**Produkční server bez těchto proměnných odmítne všechno**
(`DAWMAIN_REQUIRE_AUTH`, a i bez něj `NODE_ENV=production`) — prázdná nebo
chybějící konfigurace by jinak tiše zveřejnila celý server. Anonymní provoz
je možný jen v `npm run dev`. Aktuální stav hlásí `dawmain_ping` polem `auth`
(`oauth+token` / `oauth` / `token` / `open`).

### Nastavení Clerku (jednorázově, dashboard.clerk.com)

1. **Přihlašovací metody**: v aplikaci *Configure → Email, phone, username*
   nech zapnutý e-mail (heslo a/nebo e-mailový kód). Sociální přihlášení
   (Google apod.) jde kdykoli přidat v *SSO connections* — čistě dashboard,
   kód se nemění.
2. **Dynamic Client Registration** (nutné pro MCP klienty typu claude.ai):
   *Configure → OAuth applications → povolit Dynamic Client Registration*.
3. **API klíče**: *Configure → API keys* → `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
   a `CLERK_SECRET_KEY` vlož do `/etc/dawmain/env` a nasaď znovu
   (`deploy.sh`; publishable key se čte při buildu).
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
text (DMD), server ho uloží do PostgreSQL na vlastním serveru (databáze
`files`, [infra/proxmox.md](infra/proxmox.md)), zaindexuje (český stemmer
běží v aplikaci), navrhne metadata (heuristiky, text dokumentu neodchází k žádnému
poskytovateli AI) a hned po zpracování v
nich hledají nástroje `files_*` (metadata uživatel opraví v detailu
dokumentu; krok kontroly před hledáním zapne knihovně
`settings.autoConfirm = false`). Originál souboru se ukládá vedle textu
(`doc_originals`, po 8MB částech) jen pro uživatele: ke stažení a otevření na
stránce `/soubory`, nástroje MCP pracují jen s textem. Pojistky
níže vznikly pro bezplatné plány Vercelu a Neonu (jejich překročení
pozastavilo celý tým, resp. zablokovalo zápisy) a zatím platí beze změny.
Bez nastavení je funkce vypnutá (`FILES_MODE` chybí → `off`, chybí
`FILES_DATABASE_URL` → `unconfigured`).

### Migrace a role aplikace

Migrace (`src/files/db/migrations/*.sql`) se pouštějí ručně z terminálu,
vlastnickým připojením (`files_owner`, heslo v `/root/files-db-urls.env` v CT
`web`), **před** nasazením, které je potřebuje — nikdy při buildu:

```bash
DATABASE_URL_UNPOOLED='postgresql://files_owner:…@10.10.10.2:5432/files' \
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
| `0005_search_filters.sql` | přetížení obou funkcí: filtry `case_number` a `section` (§ i s vnořenými oddíly) přímo v SQL před stropem shod na dokument, strop na dokument až 200 (hledání uvnitř dokumentu), knihovna u každé shody, ISBN/DOI z metadat dokumentu; podpisy z `0004` zůstávají, dokud je volá nasazená verze |
| `0006_always_enabled.sql` | přepínač zapnuto/vypnuto u dokumentu zmizel z webu i API: zapne zpět všechny dříve vypnuté dokumenty (sloupec `enabled` zůstává) |
| `0007_drop_ai_usage.sql` | odstraní sloupce `usage_daily.ai_calls` a `ai_microusd`, zbylé po zrušeném AI návrhu metadat |
| `0008_originals_folders.sql` | původní soubory (`doc_originals` po částech, `documents.original_status`), složky (`folders`, `documents.folder_id`), RLS a granty pro obě nové tabulky, `files_library_bytes()` pro Správu |

**Tahle verze potřebuje `0003` až `0006`** — pusť `--dry-run`, pak
migraci, a teprve potom nasazuj. `0003`–`0005` přidávají jen sloupce `IF NOT
EXISTS`, indexy a funkce; `0006` jen zapne vypnuté dokumenty. Po nasazení je navíc potřeba přeindexovat starší
dokumenty (`ANALYZER_VERSION` 2, viz Kapacita).

Role `dawmain_app` nesmí obcházet RLS (`NOBYPASSRLS`, ne superuživatel). Na
serveru ji založil ručně superuživatel a migrace `0002` ji jen zdědí (postup
v [infra/proxmox.md](infra/proxmox.md), „Databáze `files`“); lokálně ji
`0002` založí sama. Heslo jí dej jednou jako vlastník; do gitu nepatří:

```sql
ALTER ROLE dawmain_app WITH LOGIN PASSWORD '<dlouhé náhodné heslo>';
```

`FILES_DATABASE_URL` pak míří na databázi s touto rolí:
`postgresql://dawmain_app:<heslo>@10.10.10.2:5432/files`.
Klient při prvním připojení ověří, že role nemá `rolbypassrls` (ani
`pg_read_all_data`), jinak odmítne běžet; `withScope` nastavuje knihovny jen
transakčně, takže by byl bezpečný i pooler v režimu transakcí.

### Proměnné prostředí

Na serveru v `/etc/dawmain/env`; po změně restart služby (`NEXT_PUBLIC_*`
až novým buildem, `deploy.sh`).

| Proměnná | Význam | Výchozí |
| --- | --- | --- |
| `FILES_MODE` | hlavní vypínač: `on`, `readonly` (hledání, čtení a mazání, bez nahrávání), `off` | `off` |
| `FILES_DATABASE_URL` | URL role `dawmain_app`; bez ní `unconfigured` | — |
| `DATABASE_URL_UNPOOLED` | vlastnické připojení (`files_owner`), jen pro `scripts/db-migrate.mjs` z terminálu; aplikace ho nečte | — |
| `FILES_GLOBAL_MAX_PAGES` | strop stran pro celou instalaci | 30 000 |
| `FILES_PERSONAL_MB` | kvóta osobní knihovny (MB původních souborů) | 100 |
| `FILES_TEAM_MB` | výchozí kvóta týmové knihovny (MB původních souborů) | 1024 |
| `FILES_MAX_FILE_MB` | největší jeden nahrávaný soubor (MB) | 100 |
| `FILES_EXPORT_PAGES_PER_DAY` | kolik stran textu si jeden uživatel za den exportuje | 10 000 |
| `FILES_OPERATOR_IDS` | Clerk `user_…` oddělená čárkou — provozovatelé Vlastních zdrojů (`src/files/operator.ts`) a zároveň správci na `/sprava` | — |
| `ADMIN_USER_IDS` | Clerk `user_…` oddělená čárkou — správci na `/sprava` bez ohledu na Clerk: první správce a cesta zpět. Další správce se povyšují na stránce Správa (`publicMetadata.role = "admin"`) | — |
| `FILES_GLOBAL_UPLOADS_PER_DAY` | nahrání za den ve všech knihovnách dohromady | 200 |
| `FILES_CPU_MS_DAY` | CPU zpracování (nahrání, zpracování, přeindexování) za den v ms | 600 000 (10 min) |
| `FILES_CPU_MS_30D` | totéž za klouzavých 30 dní (dimenzované na bývalý Vercel Hobby) | 3 600 000 (60 min) |
| `CLERK_WEBHOOK_SIGNING_SECRET` | podpisový klíč webhooku Clerku (`whsec_…`) | — |
| `CRON_SECRET` | `dawmain-cron.service` ho posílá jako `Authorization: Bearer …`; bez něj cron odmítne všechno | — |
| `ZOTERO_OAUTH_CLIENT_KEY` | Zotero: Client Key aplikace z zotero.org/oauth/apps (viz Zotero — provoz) | — (Zotero vypnuté) |
| `ZOTERO_OAUTH_CLIENT_SECRET` | Zotero: Client Secret téže aplikace | — (Zotero vypnuté) |
| `CREDENTIALS_SECRET` | Zotero: klíč pečetění uložených klíčů (AES-256-GCM přes HKDF), ≥ 32 znaků, `openssl rand -base64 32`; změna = všichni připojí Zotero znovu | — (Zotero vypnuté) |

Kvóta knihovny se počítá z velikosti uložených původních souborů (dokumenty
nahrané dřív, u nichž se originál neukládal, se nepočítají); vlastní kvótu
účtu nebo týmu v MB nastaví správce na `/sprava`. Strana = 3 600 znaků
převedeného textu včetně poznámek (`PAGE_CHARS`) — zůstává jen pro globální
strop `FILES_GLOBAL_MAX_PAGES` a denní stropy.

### Clerk

1. *Configure → Organizations*: zapnout, **Membership optional** (osobní
   účty zůstanou; s „required“ by každý uživatel včetně těch, kdo jen
   připojují MCP, dostal úkol vybrat si organizaci), **vypnout Allow
   user-created organizations**. Výchozí limit je 5 členů na tým; zdarma jde
   zvednout nejvýš na 20.
2. **Týmy spravuj na `/sprava/tymy`** (záložka Týmy ve Správě): založení,
   přejmenování, zapnutí/vypnutí, kvóta, přidání a odebrání členů a jejich
   role. Členové nikoho nezvou, týmy přiděluje jen správce Dawmainu. Tým
   zakládá server bez tvůrce (`createOrganization` bez `createdBy`), takže
   se správce Dawmainu nestává jeho členem a týmové dokumenty nevidí. Nový
   tým je rovnou aktivní (`public_metadata.pro = true`). Řádek tabulky
   otevře detail týmu: členy, počet sdílených dokumentů a stran a kvótu.
   Vypnutí týmu = jako odebrání Pro: cron knihovnu do týdne smaže, pokud ho
   nezapneš znovu. Smazání týmu = webhook `organization.deleted` (nebo denní
   kontrola) označí knihovnu k výmazu. Výchozí kvóta týmu je
   `FILES_TEAM_MB` (1 GB), vlastní kvóta (MB) se nastaví v detailu týmu.

   Role: **správce týmu** (`org:admin`) upravuje a maže všechny dokumenty
   týmu, **člen** (`org:member`) jen své; nahrávat smějí všichni členové
   aktivního týmu, i bez osobního Pro. Zotero a UKAŽ tým nedává, ty jsou
   dál jen osobní. Na webu má člen v modalu Vlastní soubory záložky
   Osobní / <tým>; MCP `files_search` a `files_list` hledají v osobní knihovně i ve
   všech týmech, filtr `library` („osobni“ nebo tým) rozsah zúží.

3. **Pro se přiděluje v public metadata** (*Users → uživatel → Metadata*,
   u týmu to za tebe nastaví `/sprava/tymy`): `{ "pro": true }` — přesně
   boolean `true`. Vlastní kvóta úložiště v MB: `{ "pro": true, "filesQuota": { "mb": 500 } }`.
   Projeví se do minuty (přístup se cachuje 60 s).
4. **Vypnutí jednotlivých funkcí** (tamtéž, public metadata uživatele nebo
   týmu): Pro zapíná všechno, jednotlivou funkci vypne `false` pod
   `features`:

   ```json
   { "pro": true, "features": { "zotero": false } }
   ```

   Funkce: `files` (Vlastní zdroje — hledání, čtení a nahrávání, `files_*`)
   a `zotero` (`zotero_*` a připojení Zotera na webu). Vypíná jen přesně
   boolean `false`; chybějící klíč, `true` nebo cokoli jiného funkci nechá
   zapnutou a bez Pro ji žádný přepínač nezapne. **U týmu** vypne funkci
   `files` jen v tom týmu (Zotero tým nedává vůbec); **u uživatele** mu ji vypne všude, i v jeho týmech. Projeví se do
   minuty (přístup se cachuje 60 s); seznam nástrojů v klientu zůstane,
   nástroje odpoví jako bez Pro a asistent je v konverzaci dál nevolá.
   - `files: false` knihovnu jen **pozastaví**: je dál vidět, dá se z ní
     mazat i exportovat text, ale asistent v ní nehledá a nahrávat nejde.
     K výmazu ji denní kontrola neoznačí — ta hledí jen na `pro`
     (`libraryOwnerState`), vypnutí funkce nikdy nic nesmaže.
   - `zotero: false` uložené připojení nechá být: web ukáže „Jen v režimu
     Pro“, `zotero_*` odmítnou a po opětovném zapnutí vše funguje bez
     nového připojení (odpojit se jde i mezitím).

   Logika je v `buildAccess` (`src/files/access.ts`, `featureOff`), brána
   nástrojů v `personalProCaller(ctx, feature)` (`src/mcp/pro-caller.ts`).
5. **Odebrání Pro**: smaž `pro`. Denní cron to zaznamená (`pro_revoked_at`);
   asistent v knihovně přestane hledat, uživatel ji do výmazu (6 dní + nejvýš
   den do cronu, `/soukromi` říká „do týdne“) vidí, může mazat a stahovat
   text svých dokumentů, pak se smaže. Vrátí-li
   se Pro dřív, než výmaz proběhne, cron označení zruší (nahrání do knihovny
   ji oživí hned). **Před smazáním mu napiš** (slibují to zásady ochrany
   osobních údajů); knihovny s odebraným Pro ukazuje stránka provozu.
6. **Webhook**: *Configure → Webhooks → Add endpoint*
   `https://<doména>/api/webhooks/clerk`, události `user.deleted`,
   `organization.deleted`, `organizationMembership.deleted`; *Signing
   secret* → `CLERK_WEBHOOK_SIGNING_SECRET` → restart služby. Smazání
   účtu nebo týmu označí knihovnu k výmazu za 7 dní (vymaže ji denní cron).
   Doručení Clerk nezaručuje; výpadek webhooku zachytí denní kontrola Pro
   v cronu (smazaný účet ani tým Pro nemá).

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
  vypne nahrávání vždy — pojistka se měří jen po 30 s.
- **Zmenšení souborů** (`VACUUM FULL`): stránka provozu ukáže plán, jakmile
  jde uvolnit aspoň 20 % stropu — pořadí tabulek, které se vejdou, a ty, které
  se nevejdou, dokud z nich nesmažeš dokumenty. Pouštěj jako vlastník, v
  klidném okně, **tabulky po jedné** (každá je po dobu přepisu zamčená).
  Přepis zapíše novou kopii tabulky i indexů, než smaže starou — potřebuje
  volné místo pod stropem 0,5 GB zhruba ve velikosti živých dat té tabulky.
- **CPU zpracování**: nahrání, zpracování a přeindexování si zapisují vlastní
  čas CPU (`usage_daily.cpu_ms`, jen synchronní práce — ne čekání na síť ani
  cizí požadavky na téže instanci). Nad 10 min za den nebo 60 min za 30 dní
  (čtvrtina 4 h Active CPU bývalého Vercel Hobby; `FILES_CPU_MS_DAY`, `FILES_CPU_MS_30D`)
  se nové nahrání odmítne (429) a přeindexování počká; nad 200 nahrání za den
  ve všech knihovnách také (`FILES_GLOBAL_UPLOADS_PER_DAY`).
- **Odhad CU-h** (zbytek z Neon Free, který neměl API spotřeby; na vlastním
  serveru nic neúčtuje, ale pojistka dál platí): aplikace si zapisuje
  každou minutu, kdy sáhla do DB (`db_activity`), a počítá sjednocení
  intervalů [minuta, minuta + 5 min] × 0,25 CU. Každé probuzení stojí aspoň
  5 minut — i proto nástroje nesahají do DB kvůli volajícím bez Pro.
- **Vypínač**: přepínač režimu na stránce provozu (`system_state`, bez
  restartu, projeví se do 30 s), nebo `FILES_MODE=off` + restart služby. Když
  pojistky vypnou funkci kvůli CU-h (90 %), každá instance si to pamatuje do
  začátku dalšího měsíce UTC a DB kvůli tomu nebudí; přepínač „off“ se ale
  čte každých 30 s. **Dotazy do DB úplně zastaví jen `FILES_MODE=off` +
  restart služby.**
- Pool nenastavuje žádné startovní parametry (pooler v režimu transakcí by
  `statement_timeout` při startu spojení odmítl); `withScope` nastavuje
  `statement_timeout` pro každou transakci (`set_config(…, true)`): 10 s,
  60 s pro zpracování, přeindexování a výmaz. `connectionTimeoutMillis` 4 s —
  nedostupná databáze dá rychlou odpověď „dočasně nedostupné“, ne 60 s čekání.
- **Přeindexování po uložení metadat** (změna typu dokumentu nebo
  komentovaného předpisu): nejvýš 20 za den na knihovnu; žádné, dokud je
  vyčerpaná společná rezerva CPU (výše). Opakované uložení během běžícího
  přeindexování se k němu připojí. Odmítnuté zůstanou označené a dožene je
  denní cron.
- Denní cron (`/api/cron/files`, `dawmain-cron.timer` ve 04:00 místního
  času): pojistky a velikost DB; výmaz knihoven po lhůtě
  (knihovnu, kterou mezitím nahrání oživilo, nechá být); kontrola Pro (≤ 50
  dotazů do Clerku; obnovené Pro u knihovny označené k výmazu po 6 dnech
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
na 20 000. **Po prvních 3 skutečných knihách změř** (`psql` jako vlastník
`files_owner` — roli aplikace RLS nic neukáže):

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

**Zálohy zatím nejsou.** `backup-files.sh` a `dawmain-backup.timer` jsou
připravené, ale vypnuté. `/soukromi` dnes říká, že databázi pravidelně
nezálohuješ a smazaný dokument může zůstat nejvýš ve snímku CT `pg`
pořízeném před údržbou databáze, dokud ho nesmažeš — snímky proto po
údržbě mazat. **Než zálohu zapneš, uprav `/soukromi`** (jak dlouho smazané
dokumenty v záloze přežijí) a podmínky („Záloha není“). Originály mají
uživatelé u sebe.

Strop databáze (`LIMITS.dbBytesCap` 400 MB pod 0,5 GB) je zbytek z Neon Free;
na vlastním serveru ho jde zvednout spolu se stropy stran (`src/files/config.ts`).

### Provoz a stav systému

Stránka `/vlastni-zdroje/provoz` je pryč. Stav serveru, velikosti databází,
zrcadlo judikatury a poslední běhy úloh ukazuje `/sprava/system` (záložka
Systém ve Správě, `src/admin/system.ts`). Přepnutí režimu, přeindexování
a odstranění obsahu zůstaly jako funkce v `src/files/operator.ts`
(`writeModeOverride`, `recordReindex` s `reindexBatch`, `takedownContent`)
bez webového rozhraní; volají se ze skriptu nebo přímo v databázi.

### Export textu

Kdo dokument nahrál, a správce týmu u všech týmových, si v detailu stáhne jeho
uložený text („Exportovat text“, `GET /api/files/documents/[id]/export?lib=`):
DMD s hlavičkou metadat (název, autoři, rok, typ, původní soubor, knihovna,
data). Pro není potřeba — tak si uživatel text stáhne i po odebrání Pro
než se knihovna smaže, a plní se právo na přenositelnost; nejde jen při `FILES_MODE=off`. Stropy: jeden
dokument nejvýš 10× za den (`EXPORTS_PER_DOC_PER_DAY`) a jeden uživatel za den
nejvýš `FILES_EXPORT_PAGES_PER_DAY` stran (10 000) — jinak 429. Počítadla `read:<uživatel>:…` maže cron po 2
dnech, každé stažení zapíše audit `document.export` (délka, ne text). Když
export nejde a uživatel napíše (zásady slibují pomoc), zapni funkci aspoň
v režimu `readonly` — export v něm běží — a dej mu vědět.

### Nezákonný obsah

Kontaktní místo podle DSA čl. 11 a 12 (úřady, Komise i uživatelé) je e-mail
`CONTACT` z `app/_legal.tsx`, česky a anglicky; podmínky slibují, že odpovídáš
osobně. Když se adresa změní, změní se v obou textech najednou.

Podmínky slibují postup pro oznámení (DSA čl. 16): ověř oznámení, obsah
odstraň a zablokuj, aby nešel nahrát znovu, a nahrávajícímu pošli odůvodnění
(DSA čl. 17). Webové rozhraní pro to už není (stránka provozu je pryč):
zavolej `takedownContent(actor, cíl, důvod)` ze `src/files/operator.ts`,
kde cíl je ID dokumentu nebo SHA-256 jeho textu a důvod odkaz na oznámení.
Hash se zablokuje, smažou se všechny kopie ve všech knihovnách (se správně
vrácenými stranami) a zapíšou se auditní záznamy (`content.takedown`,
`document.takedown`). Blokace platí jen pro
přesně tentýž převedený text (normalizovaný) — jiný převod téhož díla má jiný
hash. Počítadla stran knihoven ručně neupravuj: odchylky opraví noční
přepočet v cronu.

### Právní texty

Sliby v `/soukromi` a `/podminky` visí na konkrétních hodnotách — když se
změní, změň i text, zvedni „Účinné od“ (`legal.effective` v
`src/content/texts.ts`) a napiš uživatelům
měsíc předem (podmínky to slibují). `tests/files-legal-texts.test.ts` hlídá
ty, které jdou přečíst z kódu.

- zpracovatelé: jen Clerk a Cloudflare; server i databáze jsou vlastní, v
  Česku — nová služba = nový subdodavatel. Metadata navrhuje server sám
  (heuristiky) a text dokumentu neposílá žádnému poskytovateli AI;
- výmaz knihovny 6 dní po smazání účtu nebo po odebrání Pro (+ nejvýš den do
  cronu → text říká „do týdne“; platí jen, dokud `dawmain-cron.timer` běží
  denně), žádná pravidelná záloha, jen snímek před údržbou; po výmazu
  zůstane řádek knihovny bez jména a auditní záznam `library.purged`;
- retence v cronu: text neúspěšného nahrání 7 dní, počítadla čtení a stažení
  2 dny, ostatní počítadla 12 měsíců, audit do výmazu knihovny;
- export textu („Exportovat text“) — i po odebrání Pro;
- kontaktní místo DSA (čl. 11 a 12): `CONTACT`, česky a anglicky;
- provozní záznamy serveru bez pevné lhůty („jen po dobu potřebnou k řešení
  chyb“) — pevná lhůta by potřebovala nastavit retenci journald;
- kopie judikatury českých soudů (zrcadlo): veřejná rozhodnutí, anonymizovaná
  soudy, kopírovaná tak, jak jsou zveřejněná;
- cookies Clerku;
- Zotero: není zpracovatel (službu si připojuje uživatel, Dawmain na jeho
  pokyn čte), klíč jen ke čtení a zašifrovaný v `privateMetadata` Clerku,
  klíč s právem zápisu se odmítne a zruší, obsah knihovny jen v dočasné
  paměti (≤ 10 min), stažené PDF se neukládá, cookie `dz_zotero_oauth`
  (≤ 10 min) při připojování; po smazání účtu klíč zůstane na zotero.org.

Výchozí znění má „Účinné od“ 16. 11. 2026 (odchod z Vercelu a Neonu: jiní
zpracovatelé, místo uložení, žádná historie změn databáze). Texty uložené ve
Správě (`/sprava/texty`) mají přednost před výchozím zněním z repa — změna
výchozího textu se na web dostane, jen pokud dané pole uložené není.

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
raději lokální Postgres s kopií textů než produkční databázi.

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
bez sítě a bez databáze. Pro ruční zkoušení webu stačí lokální Postgres:
migrace přes `DATABASE_URL_UNPOOLED`, heslo pro `dawmain_app`,
`FILES_DATABASE_URL` + `FILES_MODE=on` v `.env.local`.
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
   `oauth_callback` při každém požadavku): pokud ano, potřebuje jiná adresa
   (lokální nebo zkušební instance) vlastní aplikaci.
2. Client Key a Client Secret do `ZOTERO_OAUTH_CLIENT_KEY` a
   `ZOTERO_OAUTH_CLIENT_SECRET`.
3. `CREDENTIALS_SECRET` — aspoň 32 znaků (`openssl rand -base64 32`);
   `src/secrets/seal.ts` z něj HKDF odvozuje klíč AES-256-GCM.

Bez kterékoli z nich (nebo bez Clerku) je Zotero vypnuté: nástroje odpoví
„není na tomto nasazení“, modál „nedostupné“. Po změně restart služby.

### Kde leží klíč

V Clerku, `privateMetadata.zotero` (`src/zotero/store.ts`): `{v: 1, userID,
username, sealed, fp, notes, groups, connectedAt, revokedAt}`. Klíč je
zapečetěný (AES-256-GCM, AAD `zotero:<userId>` — zkopírovaný blob nejde
otevřít pod jiným účtem), `fp` je krátký otisk klíče. Databáze se nepoužívá, data
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
klíčích z ní za 300 s — a IP serveru sdílí všichni uživatelé. Proto:
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

### Živý checklist

Na instanci s proměnnými výše, `MCP_URL=… npm run smoke` a `SMOKE_LIVE=1`
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
   vysvětlení; v logu služby (`journalctl -u dawmain-web`) čas a paměť převodu.
6. Smazat klíč na zotero.org: přijde právě jedna 403, připojení se označí,
   další volání skončí na bráně bez požadavku a modál hlásí „Klíč přestal
   platit“.
7. „Odpojit“: klíč zmizí na zotero.org a v Clerku je `null`.
8. Sdílený kód (kde je nastavený) i účet bez Pro dostanou odmítnutí.
9. V logu služby nejsou klíče, tokeny ani verifier.

Zároveň ověřit, zda Zotero vynucuje registrovaný callback (výše).

### Fixtures k nahrazení

`tests/fixtures/zotero/*.json` jsou **ručně sestavené z dokumentace** (z
vývojového kontejneru nebyl api.zotero.org dostupný). Na živé instanci je nahradit
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
   v `src/mcp/databases.ts` — odznaky i statická `GET /api/status` (kontrola
   nejvýš jednou za hodinu, mimo Clerk) čtou ten samý seznam.
5. Anotace, `isoDate`, `find`/stránkovací popisy a `fail()` ber
   z `src/mcp/tools/shared.ts`, nekopíruj je.

## Správa (`/sprava`)

Stránka jen pro správce (jinak 404): účty z Clerku s rolí, Pro, přepínači
funkcí a využitím nástrojů. Vstup je v menu avataru vpravo nahoře (položka
Správa). Správce je účet z `ADMIN_USER_IDS` / `FILES_OPERATOR_IDS` nebo s
`publicMetadata.role === "admin"`; každé načtení i každá akce to ověřuje znovu
(`src/admin/server.ts`). Vlastní roli správce si správce odebrat nemůže a
správce z proměnných prostředí nejde odebrat vůbec.

Co přepínače zapisují (do `publicMetadata`, odkud to čte `src/files/access.ts`):
`role` (`"admin"` / `"user"`), `pro`, `features.files` a `features.zotero`
(`false` vypíná), `features.ukaz` (UKAŽ, `doctrine_*`; zapíná se jen výslovným
`true`, hlídá to `src/mcp/doctrine-gate.ts`; sdílený přístupový kód a volání bez
účtu ho mají jako dřív). Změna se projeví do minuty (cache přístupu).

Využití: počty volání nástrojů podle účtu a dne (`usage_daily`, scope
`calls:<kdo>:<nástroj>`, `src/mcp/usage.ts`), nikdy obsah volání. Počítá se jen
tehdy, když jsou Vlastní zdroje zapnuté (zápis jde do jejich databáze).

### Texty (`/sprava/texty`)

Správce tu přepíše texty webu, které nejsou „automatické“: nadpis a úvod
hlavní stránky a text karty Owl, řádky pod Vlastními soubory, Zoterem a UKAŽ,
datum účinnosti a celé znění Podmínek užití a Zásad ochrany osobních údajů.
Seznam zdrojů s kontrolkami, návod k připojení, navigace a tlačítka zůstávají
v kódu. Pole a jejich výchozí znění jsou v `src/content/texts.ts`; nové pole
se přidá tam a na místě, kde se má zobrazit.

- **Formát** (`src/content/markdown.tsx`): prázdný řádek odděluje odstavce,
  jeden konec řádku je zalomení; `**tučně**`, `*kurzíva*`, `[text](adresa)`;
  u právních stránek navíc `## Nadpis` (otevírá oddíl) a `- ` seznam. Renderuje
  se do React elementů, nikdy do HTML řetězce, takže nic, co správce napíše,
  se nestane značkou; odkaz smí vést jen na `http(s)`, `mailto:` nebo cestu
  tohoto webu. Jednořádková pole jsou prostý text.
- **Uložení** (`src/content/store.ts`): jen odchylky od výchozího znění, jako
  jeden JSON pod klíčem `site_texts` v `system_state` databáze Vlastních
  zdrojů. Pole uložené zpět na výchozí znění se z uložených smaže, takže se k
  němu dostane i pozdější změna výchozího textu v kódu.
- **Stránky zůstávají statické.** Texty čtou při buildu a po uložení
  (`saveTextAction` volá `revalidatePath` pro `/`, `/podminky` a `/soukromi`),
  nikdy při návštěvě — návštěva nesmí sahat do databáze. Když databáze není
  nastavená nebo neodpoví, stránka ukáže výchozí znění z repa a editor hlásí,
  že uložit nejde. Pozor: když čtení selže při buildu, zůstane na webu výchozí
  znění, dokud se některé pole znovu neuloží nebo neproběhne další nasazení.
- **Sliby v právních textech** hlídá `tests/files-legal-texts.test.ts` jen
  nad výchozím zněním. Co správce uloží v editoru, už testy nevidí — kdo mění
  Podmínky nebo Zásady, odpovídá za to, že sedí s tím, co kód dělá (lhůty
  výmazu, zpracovatelé), a změní s nimi i „Účinné od“.
- Do logu jde, kdo změnil které pole a kolik znaků, nikdy text sám.
