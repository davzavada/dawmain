# Vývojová dokumentace

Technické zázemí serveru Dawmain — nástroje, architektura, vývoj a nasazení.
Uživatelský popis je v [README](../README.md).

## Nástroje

| Nástroj | Zdroj | Co dělá |
| --- | --- | --- |
| `esbirka_search` | e-Sbírka | fulltext v Sbírce zákonů |
| `esbirka_get_act` | e-Sbírka | metadata a historie znění předpisu |
| `esbirka_get_text` | e-Sbírka | konsolidovaný text k datu — celý předpis, nebo jeden § |
| `ns_search` / `ns_get_decision` | rozhodnuti.nsoud.cz | judikatura NS: fulltext s Domino operátory (AND/OR/NOT, fráze, `nájem*`, NEAR/SENTENCE/PARAGRAPH), přesná sp. zn. (`[spzn1]`–`[spzn4]`), typ rozhodnutí, kategorie A–E, datum rozhodnutí i datum předání na web |
| `nss_search` / `nss_get_decision` | vyhledavac.nssoud.cz | judikatura NSS i krajských správních soudů: fulltext, sp. zn., aplikovaný předpis a ustanovení (`applies_act`/`applies_treaty`/`applies_eu_regulation`/`applies_eu_directive` + `applies_provision`), soud/senát vč. rozšířeného, rejstřík, oblast úpravy, datum rozhodnutí i zpřístupnění — vše server-side dle zachyceného POSTu formuláře (číselníky se řeší za běhu z `ciselnikTreeData`) |
| `nalus_search` / `nalus_get_decision` | nalus.usoud.cz | judikatura ÚS: fulltext (vč. zóny disentů a řazení dle významu), citace/ECLI, soudce zpravodaj i disentující, výrok, navrhovatel, napadený akt (druh/číslo/název/ust. — abstraktní přezkum bez klíčových slov), dotčený orgán, jen publikovaná, datum rozhodnutí i zpřístupnění — číselníky verbatim ze zachyceného POSTu formuláře |
| `cz_caselaw_search` | NSS + NS + ÚS | jeden dotaz paralelně přes tři vrcholné soudy |
| `justice_search` / `justice_get_decision` | rozhodnuti.justice.cz | obecné soudy (okresní/krajské/vrchní): fulltext (`match` všechna slova/jedno ze slov/fráze), spisová značka, kódy soudů, druh rozhodnutí, datum vydání i zveřejnění, aplikovaný předpis a § (`applies_act` + `applies_section`) — vše server-side přes `/api/finaldoc`, backend SPA zachycený z živého požadavku; hit nese i `affects` (co rozhodnutí udělalo s rozhodnutím nižšího soudu: CHANGE/CONFIRM/CANCEL…) |
| `curia_search` / `curia_get_document` | InfoCuria + Cellar | FULLTEXT judikatury SDEU (C i T) přes vlastní index soudu — hledá napříč všemi jazykovými verzemi; typ dokumentu, stav věci, citovaný předpis a článek (`cites_celex`/`cites_article`), předběžné otázky podle předkládajícího státu (`referred_from`), datumy — vše server-side dle zachyceného payloadu SPA | 
| `eurlex_search` / `eurlex_get_document` | Cellar SPARQL (Publications Office) | EU legislativa, judikatura i legislativní materiály (návrhy COM, sdělení, zelené/bílé knihy, SWD, impact assessmenty, stanoviska EHSV/VR, postoje EP a Rady) dle názvů, CELEX/ECLI, typů a dat; texty z oficiálního Cellaru |
| `eurlex_legislative_history` | Cellar SPARQL (Publications Office) | travaux préparatoires aktu z dossieru interinstitucionálního postupu (`cdm:dossier_contains_work` — obsahuje i přijatý akt, takže kotví CELEX aktu i kteréhokoli dokumentu postupu, případně číslo postupu `2012/0011(COD)`); vrací návrh s důvodovou zprávou, impact assessmenty, stanoviska, postoje EP/Rady + číslo postupu, právní základ a stav (přijato/projednáváno/staženo) |
| `doctrine_search` | peacepalace.on.worldcat.org + cuni.primo.exlibrisgroup.com | doktrína: knihy, kapitoly a články ze dvou knihovních katalogů naráz — Peace Palace Library (WorldCat Discovery: WorldCat.org + licencované právnické kolekce) a UKAŽ Univerzity Karlovy (Primo VE: katalog UK + Central Discovery Index); `query`/`queries`, `title`, `author`, `subject`, `language`, `year_from`/`year_to`; katalogy stránkují po 10, `per_source_limit` (≤ 20; nad 10 záznamy stručně, bez abstraktů) stáhne víc stránek v paralelní dávce a `page` kráčí dál — vrací bibliografické záznamy s odkazem na záznam, abstraktem/obsahem a přístupovými odkazy, žádné plné texty; oba klienti postavené na zachycených požadavcích SPA (HAR 2026-09) |
| `dawmain_ping` | — | které nasazení odpovědělo |
| `dawmain_probe_sources` | — | diagnostika všech upstreamů z nasazené funkce; `include_raw` pro záchyt fixtures, `discover` pro hledání neověřených endpointů |

Známá omezení (přiznaná i v popisech nástrojů): NS adresuje jen prvních 900
výsledků dotazu (zužuj dotazem, ne stránkováním); justice.cz drží data od
10/2020, převážně civilní prvoinstanční, a neohraničený fulltext je pomalý.
Odkazy na rozhodnutí NS nesou `&Highlight=0,<termy>`, takže se dokument otevře
rovnou na hledaném místě.
Doktrína: WorldCat Discovery podepisuje **každý** požadavek SPA (hlavičky
`Oclc-Apik`/`Oclc-Apin`, na každém volání jiné, plus relační `api-token`) —
algoritmus žije v bundlu SPA, který zachycený HAR neobsahuje, takže server
posílá nepodepsané volání a odmítnutí (401/403) hlásí jako odmítnutí; kanárek
`worldcat` to ukáže hned po nasazení. Primo VE: HAR byl exportovaný bez
`Authorization`, není tedy jisté, jestli `pnxs` vyžaduje guest JWT SPA;
klient nejdřív volá bez něj a na 401/403 zkusí guest-token endpoint (z
paměti, ne z HARu) a hlásí, když neuspěje. Oba katalogy jsou knihovní, ne
open access: přístupové odkazy v záznamech mohou vyžadovat přihlášení
čtenáře — přihlášení účtem čtenáře (Peace Palace SAML, UK CAS) server zatím
neumí, viz `docs/research/doctrine-sources.json`.
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
proxy.ts                    Clerk proxy (jen /api + /__clerk; no-op bez klíčů)
src/mcp/auth.ts             ověřování tokenů (Clerk OAuth, sdílený kód), metadata
src/mcp/tools/<zdroj>.ts    tenké MCP nástroje (schema → klient → tvar odpovědi)
src/mcp/tools/shared.ts     společné pro všechny nástroje: READ_ONLY anotace,
                            isoDate, toolFailure(), texty popisů (`find`,
                            stránkování) - popisy čte model před každým
                            voláním, takže kopie by ho učila dvě různá pravidla
src/mcp/tools/previews.ts   read_top: paralelní načtení textů nejlepších hitů
src/sources/<zdroj>.ts      klient zdroje; fetchX() (I/O) oddělené od parseX() (pure)
src/sources/shared/         fetchUpstream, CookieSession, chybová taxonomie, char-paging
docs/research/*.json        verbatim rešerše endpointů všech zdrojů
tests/                      unit testy parserů a fetchUpstream proti fixtures
scripts/smoke.mjs           end-to-end test po drátě (obě generace protokolu)
```

Zásady: každý nástroj má `annotations` (vše read-only), stránkování
(`limit`/`offset` či `page`, `has_more`), `structuredContent` + čitelný text a
chybové hlášky, které říkají, co zkusit jinak (`PARSE_DRIFT` = upstream změnil
layout → spusť probe). Kde se dá kritérium ztratit (přejmenovaná pole
formuláře NSS), se raději hlásí `PARSE_DRIFT` než tipuje podle datového typu:
tichá odpověď na jinou otázku je pro rešerši horší než chyba. Rychlost: opakovaná identická volání jdou z per-instance
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
produkci. Bez `vercel.json`; Next.js si Vercel detekuje sám.

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
- NS: fulltext hledá v celé databázi, dotaz jde nahoru tak, jak ho volající
  napsal. Dřív tu byla záchrana, která odmítnutý bezdatumový dotaz tiše
  zopakovala v okně 12 měsíců a pak 90 dnů; byl to workaround na HTTP 500,
  které způsoboval náš vlastní malý `Count` (viz `NS_MIN_COUNT`), a po jeho
  opravě už jen schovávala archiv, aniž by se kdo ptal. Odmítnutí se dnes
  hlásí jako odmítnutí. Domino odmítá malé `Count`, takže se vždy žádá aspoň
  20 řádků a ořezává se lokálně.
- Scan § v e-Sbírce je stropovaný 15 stránkami a končí hned po naplnění
  limitu; hledání na justice.cz má 30s timeout (neohraničený fulltext je nad
  výchozích 15 s).
- Texty dokumentů se vracejí po stránkách 45 000 znaků (bezpečně pod limity klientů) — typické rozhodnutí
  v jedné odpovědi; delší texty nesou pokyn agentovi pokračovat bez ptaní.
- Timeouty: výchozí 15 s/request; odchylky: NSS POST 25 s, Cellar retrieval 25 s,
  Cellar SPARQL 30 s, justice.cz hledání 30 s, e-Sbírka SPARQL 20 s. Celá
  invokace ≤ 60 s.

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
   middleware, jen na `/api` a `/__clerk`) je to, co `auth()` v route
   zprovozňuje; bez klíčů je no-op.
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

## Přidání zdroje

1. `src/sources/<zdroj>.ts` — klient s odděleným `fetchX`/`parseX`.
2. `src/mcp/tools/<zdroj>.ts` — `register<Zdroj>(server)`.
3. Řádka v `src/mcp/tools/index.ts`, kanárek do `src/mcp/tools/probe.ts`,
   testy do `tests/`, jméno nástroje do `EXPECTED_TOOLS` v `scripts/smoke.mjs`.
4. Pokud se zdroj má objevit na stránce se semaforem, řádka do `DATABASES`
   v `src/mcp/status.ts` — stránka i její fallback čtou ten samý seznam.
5. Anotace, `isoDate`, `find`/stránkovací popisy a `fail()` ber
   z `src/mcp/tools/shared.ts`, nekopíruj je.
