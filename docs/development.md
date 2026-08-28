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
| `justice_list_decisions` / `justice_get_decision` | rozhodnuti.justice.cz | obecné soudy — výpis po dnech zveřejnění (zdroj nemá server-side vyhledávání) |
| `curia_search` / `curia_get_document` | InfoCuria + Cellar | FULLTEXT judikatury SDEU (C i T) přes vlastní index soudu — hledá napříč všemi jazykovými verzemi; typ dokumentu, stav věci, citovaný předpis a článek (`cites_celex`/`cites_article`), předběžné otázky podle předkládajícího státu (`referred_from`), datumy — vše server-side dle zachyceného payloadu SPA | 
| `eurlex_search` / `eurlex_get_document` | Cellar SPARQL (Publications Office) | EU legislativa + judikatura dle názvů, CELEX/ECLI, typů a dat; texty z oficiálního Cellaru |
| `dawmain_ping` | — | které nasazení odpovědělo |
| `dawmain_probe_sources` | — | diagnostika všech upstreamů z nasazené funkce; `include_raw` pro záchyt fixtures, `discover` pro hledání neověřených endpointů |

Známá omezení (přiznaná i v popisech nástrojů): NS adresuje jen prvních 900
výsledků dotazu (zužuj dotazem, ne stránkováním); justice.cz umí jen výpis po dnech.
Odkazy na rozhodnutí NS nesou `&Highlight=0,<termy>`, takže se dokument otevře
rovnou na hledaném místě.
**EUIPO** (eSearchCLW i Guidelines) je záměrně nedostupné: právní doložky EUIPO
si výslovně vyhrazují zákaz TDM a scrapingu „jakýmikoli prostředky, včetně
botů" mimo vědecký výzkum, takže nástroje nejsou registrované a probe na EUIPO
nesahá; klienti zůstávají v `src/sources/` pro případ písemného svolení.
**ÚPV** (isdv.upv.gov.cz) zahazuje spojení z datacentrových IP (ověřeno živě z regionu fra1 na obou hostech),
takže nástroje `upv_browse`/`upv_get_decision` nejsou registrované — kód i
probe kanárky (`upv`, `upv-legacy`) zůstávají, kdyby se zdroj zpřístupnil.

## Architektura

```
app/api/mcp/route.ts        HTTP route + autentizace (OAuth přes AuthKit / sdílený kód)
app/.well-known/…/route.ts  RFC 9728 metadata — jak si klient najde OAuth login
src/mcp/auth.ts             ověřování tokenů (JWT přes JWKS, sdílený kód), metadata
src/mcp/tools/<zdroj>.ts    tenké MCP nástroje (schema → klient → tvar odpovědi)
src/sources/<zdroj>.ts      klient zdroje; fetchX() (I/O) oddělené od parseX() (pure)
src/sources/shared/         fetchUpstream, CookieSession, chybová taxonomie, char-paging
docs/research/*.json        verbatim rešerše endpointů všech zdrojů
tests/                      unit testy parserů proti fixtures
scripts/smoke.mjs           end-to-end test po drátě (obě generace protokolu)
scripts/fetch-fixtures.mjs  stáhne reálné fixtures z veřejných GitHub rep
```

Zásady: každý nástroj má `annotations` (vše read-only), stránkování
(`limit`/`offset` či `page`, `has_more`), `structuredContent` + čitelný text a
chybové hlášky, které říkají, co zkusit jinak (`PARSE_DRIFT` = upstream změnil
layout → spusť probe). Rychlost: opakovaná identická volání jdou z per-instance
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

1. *Project Settings → Environment Variables*: `AUTHKIT_DOMAIN` a/nebo
   `MCP_BEARER_TOKEN`, `ESBIRKA_API_KEY` (viz `.env.example`); *Functions →
   Region*: `fra1`. Po změně env je potřeba Redeploy.
2. Spusť smoke proti nasazení (viz výše), pak `SMOKE_LIVE=1`.
3. Zavolej `dawmain_probe_sources` — ověří všechny upstreamy z nasazení.
4. `dawmain_probe_sources {discover: true}` vypíše (a) kandidátní search
   endpoint SPA justice.cz, (b) skutečná pole formuláře NSS — obojí slouží
   k doladění `src/sources/nss.ts` a k budoucímu `justice_search`.
5. Volitelná jednorázovka v prohlížeči (DevTools → Network): zachytit XHR
   filtrovaného hledání na rozhodnuti.justice.cz — odemkne server-side filtry.

## Připojení klienta

S OAuth (AuthKit) stačí URL — klient si při prvním použití řekne o přihlášení
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
- NS: fulltext hledá v celé databázi; okno (12 měsíců → 90 dnů) se nasadí jen
  když server odmítne, a odpověď to přizná v `applied_window_from`. Domino
  odmítá malé `Count` (HTTP 500), takže se vždy žádá aspoň 20 řádků a ořezává
  se lokálně.
- Procházení justice.cz je stropované 20 stránkami na volání, scan § v
  e-Sbírce 15 stránkami; vše končí hned po naplnění limitu.
- Texty dokumentů se vracejí po stránkách 45 000 znaků (bezpečně pod limity klientů) — typické rozhodnutí
  v jedné odpovědi; delší texty nesou pokyn agentovi pokračovat bez ptaní.
- Timeouty: výchozí 15 s/request; odchylky: NSS POST 25 s, Cellar retrieval 25 s,
  Cellar SPARQL 30 s, e-Sbírka SPARQL 20 s. Celá invokace ≤ 60 s.

## Autentizace

Endpoint přijímá dvě credentials naráz (stačí kterákoli); logika žije v
`src/mcp/auth.ts`:

1. **OAuth 2.1 přes WorkOS AuthKit** (`AUTHKIT_DOMAIN`) — klient dostane na
   `401` hlavičku `WWW-Authenticate` s odkazem na
   `/.well-known/oauth-protected-resource`, tam najde autorizační server
   (AuthKit), sám se u něj zaregistruje (Dynamic Client Registration) a
   provede uživatele přihlášením — e-mail + heslo či Magic Auth, případně
   SSO, podle toho, co je v WorkOS zapnuté. Server pak jen ověřuje podpis,
   issuer a expiraci JWT proti veřejnému JWKS (`<issuer>/oauth2/jwks`) —
   **žádný WorkOS API klíč nikde nefiguruje**.
2. **Sdílený přístupový kód** (`MCP_BEARER_TOKEN`) — původní schéma,
   ponechané pro existující klienty; token se přijímá z `Authorization`,
   `X-API-Key` i `cf-aig-authorization` (stačí, když sedí kterákoli).

**Bez obou proměnných se na Vercelu odmítne všechno** — prázdná nebo chybějící
konfigurace by jinak tiše zveřejnila celý server, a to i na preview adresách;
proto proměnné zaškrtni pro Production i Preview. Anonymní provoz je možný jen
lokálně. Aktuální stav hlásí `dawmain_ping` polem `auth`
(`oauth+token` / `oauth` / `token` / `open`).

### Nastavení WorkOS AuthKit (jednorázově, dashboard.workos.com)

1. **Registrace e-mailem**: *Authentication → Email + Password* (heslo),
   případně *Magic Auth* (jednorázový kód na e-mail). Co je zapnuté, to
   AuthKit na přihlašovací stránce nabídne — beze změn v kódu.
2. *(Volitelně — aktuálně vypnuto)* **Google SSO**: *Authentication → OAuth
   providers → Google → Manage*. Ve stagingu fungují výchozí WorkOS
   credentials hned; pro produkci vlož vlastní Google Client ID + Secret
   (Google Cloud Console → Auth Platform → Clients → Web application; do
   *Authorized redirect URIs* patří Redirect URI z tohohle WorkOS dialogu,
   *JavaScript origins* zůstávají prázdné; nakonec *Audience → Publish app*).
   Návod: <https://workos.com/docs/integrations/google-oauth>. Zapnutí je
   čistě dashboardová věc, kód se nemění.
3. **Dynamic Client Registration** (nutné pro MCP klienty typu claude.ai):
   *Applications → Configuration → Dynamic Client Registration → Enable*.
4. **AuthKit doména**: zkopíruj z dashboardu (např.
   `https://<slug>.authkit.app`) do `AUTHKIT_DOMAIN` na Vercelu
   (Production i Preview) a Redeploy.
5. **Kdo se smí registrovat**: veřejná registrace pustí dovnitř kohokoli.
   Adresné rozdávání přístupu = vypnout sign-ups v AuthKitu (*Authentication →
   Sign-up*) a uživatele zvát z dashboardu (*Users → Invite*).

Ověření: `curl https://<host>/.well-known/oauth-protected-resource` musí
vrátit `authorization_servers: ["<AuthKit doména>"]`; pak připoj konektor v
claude.ai bez přístupového kódu — má se otevřít přihlašovací okno. Diskovery
kontroluje i `npm run smoke` (krok `oauth discovery`).

## Přidání zdroje

1. `src/sources/<zdroj>.ts` — klient s odděleným `fetchX`/`parseX`.
2. `src/mcp/tools/<zdroj>.ts` — `register<Zdroj>(server)`.
3. Řádka v `src/mcp/tools/index.ts`, kanárek do `src/mcp/tools/probe.ts`,
   testy do `tests/`, jméno nástroje do `EXPECTED_TOOLS` v `scripts/smoke.mjs`.
