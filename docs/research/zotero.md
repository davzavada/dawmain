# Zotero — rešerše k integraci (2026-09)

Podklad pro read-only napojení knihovny Zotero (`src/zotero/*`,
`src/mcp/tools/zotero.ts`). Provoz a nastavení: `docs/development.md`,
oddíl „Zotero — provoz“.

## Studované MCP servery (GitHub) a co jsme převzali

| Projekt | Co převzato | Co ne |
| --- | --- | --- |
| **oscardvs/zoteus** (TS, MIT) | více uživatelů přes Zotero OAuth 1.0a; API klíč přichází v `oauth_token_secret`; **nikdy neposílat `identity=1`** (Zotero pak klíč nevytvoří a vrátí doslova „identity“); ověření klíče přes `/keys/current`; dodržování `Backoff`/`Retry-After`; prázdné hledání zopakovat v režimu `everything` | vlastní úložiště tokenů (my: zapečetěné v Clerku) |
| **4965898/zotero-online-mcp** (TS, MIT) | tenký HTTP klient s `Zotero-API-Version: 3`, `redirect: "manual"` a stropem velikosti odpovědi; čtení `Total-Results` / `Link` / `Last-Modified-Version`; full text stránkovaný po znacích; 404 full textu vysvětlené jako „neindexováno / nesynchronizováno“ | — (u stahování souboru navíc allowlist hostů úložiště a žádná hlavička s klíčem za přesměrováním) |
| **kujenga/zotero-mcp** (Py, MIT) | shody v přílohách, poznámkách a anotacích seskupené pod rodičovské dílo („matched in: …“); „položky 1–10 z 57“; metadata po oddílech s „Další pole“; upozornění, že pomlčka dělí dotaz na slova | lokální SQLite / desktopové API (my jen cloud) |
| **54yyyu/zotero-mcp** (~5k★) | poučení: 38 nástrojů stálo ~13k tokenů popisů — držíme **4 nástroje** (`zotero_search`, `zotero_get_item`, `zotero_get_text`, `zotero_list`) | zápisové nástroje, sémantické hledání |

Vlastní doplněk pro právo: Zotero `q` neprohledává `docketNumber`, `court`,
`abstractNote`, `extra` ani štítky — spisová značka se proto dohledává
omezeným skenem položek `itemType=case` (`LIMITS.scanPagesPerLibrary` = 5 a
`scanPagesTotal` = 10 stránek po 100), s porovnáním přes normalizované klíče
sp. zn. (krátký rok „/19“ = „/2019“) a s přiznáním, kolik položek prošel.

## Klíčová fakta o API (Web API v3)

- Základ `https://api.zotero.org`, klíč v hlavičce `Zotero-API-Key` (ne v
  URL), vždy `Zotero-API-Version: 3`.
- OAuth 1.0a na `www.zotero.org/oauth/{request,authorize,access}`, podpis
  HMAC-SHA1; parametry authorize předvyplní formulář klíče
  (`library_access`, `notes_access`, `write_access`, `all_groups`).
- `GET /keys/current` → `userID`, `username`, `access.user` a
  `access.groups` (buď `all`, nebo po skupinách, nebo chybí);
  `DELETE /keys/current` klíč zruší (odpojení, odmítnutí klíče se zápisem).
- Neplatný klíč → 403 „Invalid key“; jiná 403 = chybějící oprávnění. Více než
  5 neplatných klíčů z jedné IP za 300 s → 429 pro **celou IP**.
- Nejvýš 5 souběžných požadavků na uživatele (sdíleno se synchronizací
  desktopu); `Backoff` a `Retry-After` je třeba ctít.
- `q` + `qmode=titleCreatorYear` (výchozí) nebo `everything` (všechna pole,
  poznámky a full-text index); každé slovo musí sedět, pomlčka dělí slova;
  výsledky nejsou řazené podle relevance. `limit` nejvýš 100, `itemKey`
  nejvýš 50 klíčů.
- `GET /items/{key}/fulltext` → `content` + `indexedPages`/`totalPages`
  (nebo znaky); index vzniká jen v Zotero desktop a na server se dostane se
  zapnutou synchronizací full textu (i u WebDAV).
- `GET /items/{key}/file` → 302 na krátkodobou podepsanou URL úložiště;
  WebDAV a odkazované soubory přes API nejdou.

## Neověřeno do živého běhu

Z vývojového kontejneru byl api.zotero.org i www.zotero.org nedostupný; vše
níže je z dokumentace a zdrojů dataserveru a ověří se na Preview (checklist
v `docs/development.md`):

- přesný tvar `access.groups` v `/keys/current` a text těla 403 „Invalid key“
  (kód hledá `/invalid key/i`);
- oddělovače stran a pole `indexedPages`/`totalPages` ve full textu;
- host přesměrování `/file` (povolen kterýkoli HTTPS endpoint S3 — zúžit) a
  zda přichází `Zotero-File-Compressed`;
- zda Zotero vynucuje callback registrovaný u aplikace (jinak stačí jedna
  aplikace pro Production i Preview);
- chování `oauth/authorize` s `write_access=0` (zda uživatel může zápis
  přesto povolit — pak `stav=zapis`).

Fixtures v `tests/fixtures/zotero/` jsou ručně sestavené z dokumentace a mají
se nahradit živými záchyty (bez klíčů a tokenů).
