# Migrace z Vercelu na Proxmox

Plán přesunu webu a MCP serveru Dawmain z Vercelu (Hobby) na domácí Proxmox
([proxmox.md](proxmox.md)). Cíl: všechno připravit a ověřit předem, aby
**přepnutí bylo jedna změna DNS záznamu** a služba při něm nepřestala
odpovídat.

Stav plánu (16. 11. 2026): fáze 0 a 1 hotové a nasazené na CT `web`, z fáze 2
tunel, zkušební adresa `dawmain-novy` a WAF výjimka; zbytek čeká (viz níže
„Odchylky od plánu“ a „Co zbývá do přepnutí“). Kód běží v `main`, Vercel se
nezměnil.

### Odchylky od plánu

- `pg` se **nezmenšoval**: limit paměti není rezervace a host měl volných ~10 GB
  (s cache). Vrátit se k tomu, jen když začne docházet paměť.
- Thin pool je na ~45 %, ne skoro plný. Roste snapshot `pre-0019-structure`
  (120 GB, thin) — smazat, až nebude potřeba.
- API zrcadla poslouchá jen na LAN adrese, takže web ho volá přes
  `http://192.168.0.52:8080`, ne přes vnitřní síť; restart zrcadla odpadl.
- Za tunelem vidí Node prostý `http`: OAuth discovery proto doma bere
  `PUBLIC_URL` (bod 0.5).
- `deploy.sh` zapisuje `release.env` (`GIT_SHA`), který unit načítá, aby
  `dawmain_ping` ukazoval commit i za běhu.
- Cron unit: v `ExecStart` musí být `%%s`, ne `%s` (systemd by ho nahradil
  shellem uživatele) — zachytil test, opraveno.

### Co zbývá do přepnutí

Na uživateli: produkční proměnné z Vercelu do `/etc/dawmain/env`; zápis
Cloudflare (WAF výjimka rozšířit na `dawmain`, v přepnutí změnit CNAME);
záloha mimo stroj (účet R2 / disk) a dohled (Healthchecks / UptimeRobot).
Na přípravě (jde bez dopadu na Vercel): databáze `files` v CT `pg`, zkouška
dumpu z Neonu, generálka s Clerkem (fáze 4).

## Proč to půjde plynule

Tři vlastnosti dnešního Dawmainu, o které se plán opírá:

1. **MCP je bezstavové** (`src/mcp/server.ts`): žádné relace v paměti. Je
   jedno, které nasazení na který požadavek odpoví.
2. **Všechen stav je mimo hosting**: účty a OAuth v Clerku, Vlastní zdroje
   a počitadla v Neonu, klíče Zotera v metadatech Clerku. Vercel i domácí
   server mohou běžet **současně nad stejnými daty**.
3. **Doména se nemění** a její DNS je už na Cloudflare. Konektory uživatelů,
   Clerk (produkční instance, OAuth, webhook) ani callback Zotera se
   nepřenastavují; vydané tokeny platí dál.

Z toho plyne pořadí: domácí nasazení nejdřív běží **souběžně** s Vercelem
nad Neonem, pak se přepne doména, a teprve potom — samostatně a bez vlivu na
doménu — se stěhuje databáze z Neonu domů. Databázi nejde přestěhovat před
přepnutím (Vercel by na domácí Postgres nedosáhl) a stěhovat ji ve stejné
chvíli jako doménu by zbytečně spojilo dvě rizika do jednoho okna.

Clerk zůstává beze změny po celou dobu i potom.

## Web a MCP jsou jedna aplikace

Stěhuje se celý Next.js projekt, ne jen `/api/mcp`: úvodní stránka,
`/podminky`, `/soukromi`, `/vlastni-zdroje`, `/sprava`, návod
`/dawmain-reserse.md`, ikony i `/api/status`. Všechno obslouží tatáž služba
`dawmain-web` v CT `web`; zvláštní webhosting není potřeba. Co se pro web
mění oproti Vercelu:

- **Statické soubory** (`/_next/static/*`, `public/`): servíruje je Next ze
  standalone vydání (`deploy.sh` je tam musí zkopírovat, jinak web naběhne
  bez stylů) a Cloudflare je cachuje na okraji sám podle přípony.
- **Stránky (HTML)**: jsou předgenerované, ale Cloudflare HTML ve výchozím
  stavu necachuje — každé zobrazení dojde domů. Při dnešním provozu to
  stačí a nechávám to tak: uložení textů ve Správě se pak projeví hned, bez
  mazání cache na Cloudflare. Když server spí nebo padne, web je dole
  spolu s MCP (Vercel statické stránky držel na CDN nezávisle).
- **`/api/status`** s hodinovou revalidací drží cache Nextu místo CDN
  Vercelu; chování navenek stejné.
- **Preview nasazení** pro každou větev zaniknou; náhradou je zkušební
  adresa `dawmain-novy` (fáze 2) nebo `npm run dev`.
- **Vercel Analytics / Speed Insights** projekt nepoužívá, nic nevypadne.

Kontroly webu jsou součástí fáze 2 (vzhled, hlavičky, ikony přes zkušební
adresu) a fáze 4 (přihlášení a Vlastní zdroje na pravé doméně).

## Cílový stav

```
Internet → Cloudflare (DNS + proxy) → Tunnel dawmain-databaze (jen odchozí)
   ├─ dawmain.davidzavada.cz          → CT 103 web  :3000  (Next.js, systemd)
   └─ dawmain-databaze.davidzavada.cz → CT 102 app  :8080  (API zrcadla, beze změny)

CT 103 web ── vmbr1 ──► CT 101 pg   databáze `files` (po fázi 6; do té doby Neon)
CT 103 web ── vmbr1 ──► CT 102 app  API zrcadla po vnitřní síti (bez Cloudflare Access)
```

| CT | Jméno | RAM / vCPU / disk | LAN | Vnitřní |
| --- | --- | --- | --- | --- |
| 101 | `pg` | **6 GB** (z 8) / 4 / 120 GB | 192.168.0.51 | 10.10.10.2 |
| 102 | `app` | 4 GB / 4 / 20 GB | 192.168.0.52 | 10.10.10.3 |
| 103 | `web` (nový) | 3 GB / 4 / 12 GB | 192.168.0.53 | 10.10.10.4 |

Paměť: 16 GB = 6 + 4 + 3 + ~3 pro hostitele. `shared_buffers` 2 GB zůstává,
`effective_cache_size` klesne na 4 GB. Disk: thin pool je alokovaný skoro
celý, CT `web` ho přealokuje — před založením zkontrolovat `lvs` (Data%) a
dál ho hlídat (viz monitoring ve fázi 3).

## Fáze 0 — kód: běh mimo Vercel (větev, PR do `main`)

Úpravy jsou zpětně kompatibilní: tentýž commit běží na Vercelu i doma.

| # | Soubor | Změna |
| --- | --- | --- |
| 0.1 | `src/mcp/auth.ts` | **Bezpečnostní.** `authRequired()` dnes vynucuje přihlášení jen podle `process.env.VERCEL`. Doma by překlep v proměnné otevřel endpoint všem. Nově: vynuceno i při `DAWMAIN_REQUIRE_AUTH=1`; domácí služba ho nastavuje napevno v unit souboru. Test. |
| 0.2 | `app/page.tsx`, `src/mcp/tools/files.ts` | `VERCEL_PROJECT_PRODUCTION_URL` → nejdřív `PUBLIC_URL` (např. `https://dawmain.davidzavada.cz`), pak dosavadní hodnota. |
| 0.3 | `src/mcp/tools/ping.ts`, `src/mcp/server.ts` | `VERCEL_ENV` / `VERCEL_REGION` / `VERCEL_GIT_COMMIT_SHA` → nejdřív `APP_ENV`, `APP_REGION`, `GIT_SHA` (doplní deploy skript). `dawmain_ping` tak ukáže, **které nasazení odpovídá** — hlavní nástroj kontroly při přepnutí. |
| 0.4 | `next.config.ts` | `output: "standalone"` jen při `NEXT_OUTPUT=standalone` (nastaví `deploy.sh`), takže build na Vercelu zůstává stejný. Verzi vydání nese `NEXT_DEPLOYMENT_ID`, který Next čte sám. `SKILL.md` se do standalone výstupu přibalí (ověřeno). |
| 0.5 | `src/zotero/web.ts`, `src/files/guards.ts`, `src/mcp/auth.ts` | Čtou `x-forwarded-host` (a `mcp-handler` i `x-forwarded-proto`). Vercel ho přepisuje, Cloudflare Tunnel ho od klienta propustí. Nové `TRUST_FORWARDED_HOST=0` (doma; výchozí zůstává „důvěřovat“, aby se na Vercelu nic nezměnilo) bere jen `Host`. **Nález při ověřování:** za tunelem vidí Node prostý `http` a žádný `x-forwarded-host`, takže by OAuth discovery MCP klientům nabídl `http://…`. Doma proto adresu pro OAuth (metadata i `WWW-Authenticate`) určuje pevné `PUBLIC_URL`. |
| 0.6 | `src/sources/mirror.ts` | Beze změny kódu — Access hlavičky jsou už volitelné; doma se nastaví `MIRROR_API_URL=http://10.10.10.3:8080`. API zrcadla musí poslouchat i na `10.10.10.3` (`MIRROR_API_HOST`), ověřit. |
| 0.7 | `src/mcp/usage.ts`, `src/files/db/client.ts` | `waitUntil` a `attachDatabasePool` mimo Vercel nic nedělají a kód s tím počítá. Zůstávají do úklidu (fáze 7); jen ověřit testem, že bez Vercelu nepadají. |
| 0.8 | `deploy/web/` | Nové soubory: `dawmain-web.service`, `dawmain-cron.service` + `.timer`, `deploy.sh`, `backup-files.sh` (viz fáze 1–3). |
| 0.9 | `.env.example`, `docs/development.md` | Nové proměnné a oddíl „Nasazení doma“. |

AI Gateway: na Vercelu se ověřuje přes OIDC, doma přes `AI_GATEWAY_API_KEY`
(kód už obojí umí). Bez klíče jdou metadata z heuristik — funkční, jen horší.

Hotovo, když: `npm test`, `npm run typecheck` a `npm run build` projdou,
Vercel preview z větve se chová jako dřív a `npm run start` lokálně se
`DAWMAIN_REQUIRE_AUTH=1` bez klíčů vrací na `/api/mcp` 401.

## Fáze 1 — kontejner `web` a služba

1. Snapshot nic nestojí, ale `pg` se zmenšuje: `pct set 101 -memory 6144`,
   upravit `effective_cache_size`, restart Postgresu (zrcadlo na pár sekund).
2. `pct create 103` — Debian 13, neprivilegovaný, `nesting=1`, start po bootu,
   `eth0` 192.168.0.53, `eth1` 10.10.10.4, zóna `Europe/Prague`. Node 22.
3. Uživatel `dawmain`, repo v `/opt/dawmain-web/repo`, vydání v
   `/opt/dawmain-web/releases/<sha>`, symlink `current`.
4. `/etc/dawmain/env` (600): všechny proměnné produkce z Vercelu
   (`vercel env pull` na Macu, přenést ručně, nikdy necommitovat) plus
   `PUBLIC_URL`, `APP_ENV=production`, `APP_REGION=home`,
   `DAWMAIN_REQUIRE_AUTH=1`, `AI_GATEWAY_API_KEY`, `MIRROR_API_URL` na
   vnitřní adresu; **bez** `MIRROR_CF_ACCESS_*`. Zatím
   `FILES_DATABASE_URL` = Neon (stejná hodnota jako na Vercelu).
   `NEXT_PUBLIC_*` musí být přítomné už při buildu.
5. `deploy.sh <ref>`: `git fetch`, checkout do nového adresáře vydání,
   `npm ci`, `GIT_SHA=… npm run build`, zkopírovat `public` a
   `.next/static` do standalone, spustit smoke proti vydání na vedlejším
   portu, přepnout `current`, `systemctl restart dawmain-web`, nechat
   posledních 5 vydání. Když smoke neprojde, nepřepíná.
6. `dawmain-web.service`: `node server.js` ze standalone, `HOSTNAME=0.0.0.0`,
   `PORT=3000`, `EnvironmentFile=/etc/dawmain/env`, `Restart=on-failure`,
   `TimeoutStopSec=30` (doběhnou rozdělané požadavky), stejné zpevnění jako
   `mirror-api.service`.
7. Firewall CT: port 3000 jen z `app` (cloudflared) a z LAN pro testy.

Paměť při buildu: když `next build` ve 3 GB neprojde, dočasně
`pct set 103 -memory 5120`, nebo build na Macu a přenos hotového vydání.

Hotovo, když: z Macu `MCP_URL=http://192.168.0.53:3000/api/mcp npm run smoke`
projde s bearer tokenem i se `SMOKE_LIVE=1`, a `dawmain_probe_sources`
z domácí adresy vidí všechny zdroje (viz riziko „domácí IP“).

## Fáze 2 — tunel a zkušební adresa

1. Do `/etc/cloudflared/config.yml` (CT `app`) přidat před závěrečné 404:
   `dawmain.davidzavada.cz` a `dawmain-novy.davidzavada.cz` →
   `http://10.10.10.4:3000`. `ingress validate`, restart `cloudflared`.
   Pravidlo pro hlavní doménu je tím připravené; dokud na tunel nemíří DNS,
   nic se neděje.
2. DNS: `dawmain-novy` CNAME → `<id tunelu>.cfargotunnel.com`, proxied.
   **Bez** Cloudflare Access (MCP je veřejné, chrání ho Clerk / token).
3. Cloudflare pro obě jména: vypnout Bot Fight Mode nebo přidat WAF výjimku
   pro `/api/*` a `/.well-known/*` (jinak Cloudflare zastaví servery Claude
   a ChatGPT, které se chovají jako boti); žádné cachování `/api/*`; SSL
   Full; Rocket Loader a Email Obfuscation vypnout (mění HTML).
4. Kontroly přes zkušební adresu: smoke s bearer tokenem; `dawmain_ping`
   ukazuje `region: home`; dlouhé volání (NALUS) se nepřeruší a odpověď se
   streamuje; `/.well-known/oauth-protected-resource` vrací adresy podle
   hostitele požadavku; hlavičky z `next.config.ts` dorazí.
5. Konektor v Claude na `dawmain-novy…/api/mcp` s bearer tokenem: skutečná
   rešerše přes domácí server.

Na zkušební adrese **nefunguje přihlášení Clerkem** (produkční instance je
vázaná na `dawmain.davidzavada.cz`). To je záměr; Clerk ověří generálka.

## Fáze 3 — provoz kolem: cron, zálohy, dohled

1. **Cron**: `dawmain-cron.timer` denně 04:00 Europe/Prague →
   `curl -fsS -H "Authorization: Bearer $CRON_SECRET" http://127.0.0.1:3000/api/cron/files`.
   Nainstalovaný, ale **vypnutý až do přepnutí** — do té doby běží cron na
   Vercelu a dva souběžné úklidy nechceme.
2. **Záloha Vlastních zdrojů** (začne platit ve fázi 6, připravit teď):
   noční `pg_dump -Fc files` → šifrovaně (restic) mimo stroj — Cloudflare R2
   nebo disk na Macu; držet 7 denních + 4 týdenní. Jednou ročně zkouška
   obnovy. Neon měl obnovu k bodu v čase; doma ji nahrazuje tohle, a je to
   jediná kopie dat uživatelů mimo notebook.
3. **Dohled**: externí kontrola `https://dawmain.davidzavada.cz/api/status`
   každých 5 min s e-mailem (UptimeRobot / Healthchecks.io); cron a záloha
   po úspěchu pingnou Healthchecks (ozve se, když neproběhnou); týdenní
   kontrola `lvs` Data% > 80 % → e-mail.
4. **Logy**: `journalctl -u dawmain-web`, uchování 30 dní; žádné argumenty
   volání se nelogují (stejně jako dnes, `/soukromi`).
5. **Výpadky**: BIOS „zapnout po obnovení napájení“, baterie notebooku jako
   UPS, kontejnery startují po bootu, tunel se obnoví sám. Vyzkoušet
   vytažením ze zásuvky a restartem hostitele.

## Fáze 4 — generálka na skutečné doméně

Účel: ověřit Clerk, nahrávání a Zotero na `dawmain.davidzavada.cz` dřív, než
se doména přepne pro všechny.

1. V CT `web` dočasně Caddy na 443 s certifikátem pro
   `dawmain.davidzavada.cz` (DNS-01 přes Cloudflare API token) →
   `127.0.0.1:3000`.
2. Na Macu v `/etc/hosts`: `192.168.0.53 dawmain.davidzavada.cz`. Prohlížeč
   i `curl` na Macu teď mluví s domácím serverem pod pravým jménem; zbytek
   světa dál s Vercelem.
3. Projít: přihlášení a odhlášení (bez smyčky přesměrování), `/vlastni-zdroje`
   — nahrát, potvrdit metadata, hledat, exportovat, smazat zkušební dokument;
   `/vlastni-zdroje/provoz` a `/sprava` (Server Functions); připojit a
   odpojit Zotero; `/podminky`, `/soukromi`.
4. OAuth konektoru z Macu (Claude Code: `claude mcp add --transport http`)
   — celé kolečko objevení → přihlášení → volání nástroje.
5. Smazat řádek z `/etc/hosts`, Caddy vypnout a odinstalovat.

Co generálka neověří: webhook Clerku (chodí z internetu; má vlastní test po
přepnutí) a konektory hostované u Anthropic / OpenAI (ty ověří fáze 2 přes
bearer token a první minuty po přepnutí).

Po dobu souběhu (fáze 1–5) **neupravovat texty ve Správě**: uložení
přegeneruje statické stránky jen na tom nasazení, kde se ukládalo.

## Fáze 5 — přepnutí domény

Den předem: TTL záznamu `dawmain` je už krátké (77 s, ověřeno 14. 11.);
domácí nasazení je na stejném commitu jako produkce na Vercelu; záloha
proměnných z Vercelu uložená; oznámení není potřeba.

Přepnutí (mimo špičku, např. večer):

1. Naposledy: smoke přes `dawmain-novy`, `systemctl status dawmain-web cloudflared`.
2. Cloudflare DNS: záznam `dawmain` změnit z CNAME na Vercel (DNS only) na
   CNAME `<id tunelu>.cfargotunnel.com`, **proxied**. To je celé přepnutí.
3. Během pár minut, než doběhnou cache DNS, odpovídají obě nasazení — nad
   stejnou databází, se stejným Clerkem, bezstavově. Nikdo nedostane chybu.
4. Hned potom: zapnout `dawmain-cron.timer`; na Vercelu vypnout cron
   (nasadit s prázdným `crons`, nebo `CRON_SECRET` jen doma).
5. Kontroly: `dawmain_ping` přes produkční adresu → `region: home`;
   `curl -sI https://dawmain.davidzavada.cz` → `server: cloudflare`;
   v Clerku *Webhooks → Send test* → 200 v `journalctl`; vlastní konektor
   v Claude i ChatGPT udělá rešerši bez nového přihlášení; přihlášení na
   webu; externí dohled zelený.
6. V Cloudflare Access smazat servisní token `dawmain-vercel` až ve fázi 7.

**Návrat**: vrátit DNS záznam na původní CNAME Vercelu
(`79e0689ac82ac3bb.vercel-dns-017.com`, DNS only), zapnout cron na Vercelu,
vypnout domácí timer. Do dvou minut zpět, bez ztráty dat — obě strany pořád
píšou do Neonu. Projekt na Vercelu proto zůstává nasazený a doména v něm
přiřazená, dokud neskončí fáze 6; Vercel mezitím nic nespotřebovává.

Sledovat 7 dní: chyby v `journalctl`, odezvu, 403/429 od soudů, paměť CT.

## Fáze 6 — databáze z Neonu domů (samostatně, nejdřív týden po fázi 5)

S doménou nesouvisí; uživatel pozná jen pár minut vypnutého nahrávání.

Příprava (bez dopadu):
1. V CT `pg`: databáze `files`, vlastník `files_owner`, role `dawmain_app`
   bez `BYPASSRLS` a bez členství v nadřízených rolích (aplikace takovou
   roli jinak odmítne); `pg_hba`: jen `10.10.10.4`. Stejná verze rozšíření
   jako v Neonu (zkontrolovat `\dx`).
2. Zkouška nanečisto: `pg_dump` z Neonu (`DATABASE_URL_UNPOOLED`) →
   `pg_restore --no-owner --no-acl` → `scripts/db-migrate.mjs` (má být bez
   práce) → práva pro `dawmain_app` → porovnat počty řádků a
   `npm run files-eval` proti domácí databázi. Změřit, jak dlouho to trvá.
3. Záloha z fáze 3 běží a zkušební obnova prošla.

Přepnutí:
1. `FILES_MODE=readonly` doma, restart (hledání a čtení fungují, nahrávání
   vrací srozumitelnou hlášku). Počkat, až doběhnou rozpracované ingesty.
2. Smazat zkušební data, ostrý dump → restore → kontrola počtů.
3. `/etc/dawmain/env`: `FILES_DATABASE_URL` na `10.10.10.2` (bez pooleru,
   TLS podle `pg_hba`), `FILES_MODE=on`, restart.
4. Kontroly: `files_list` / `files_search` přes MCP, nahrát a smazat
   dokument, `/vlastni-zdroje/provoz` (počitadla, pojistky), ruční spuštění
   cronu, texty ve Správě.

Návrat: vrátit `FILES_DATABASE_URL` na Neon — beze ztráty jen do prvního
nového zápisu doma; Neon proto nechat 14 dní nedotčený a pak smazat
(a aktualizovat `/soukromi`: data už nejsou ve Frankfurtu u Neonu, ale na
vlastním serveru v ČR; Vercel a Neon vypadnou ze seznamu zpracovatelů,
Cloudflare v něm přibude).

Po přesunu ztrácí smysl pojistky bezplatných tarifů (`FILES_CPU_MS_*`,
hlídání 0,5 GB Neonu, „neprobouzet databázi“) — upravit až v úklidu, podle
skutečné kapacity disku.

## Fáze 7 — úklid

- Vercel: odebrat doménu z projektu, projekt smazat nebo nechat bez domény;
  odpojit Git integraci. Neon: smazat projekt.
- Kód: odstranit `@vercel/functions`, `vercel.json`, `neon.ts`, `@neon/*`,
  větve `process.env.VERCEL*`; `maxDuration` nechat jako dokumentaci nebo
  nahradit vlastním časovým rozpočtem (pozor: Cloudflare ukončí požadavek po
  100 s).
- Cloudflare: smazat `dawmain-novy` (DNS i ingress) a Access token
  `dawmain-vercel`; zvážit, zda `dawmain-databaze` ještě potřebuje veřejné jméno.
- Dokumentace: `docs/development.md` (nasazení, proměnné), `proxmox.md`
  (CT 103, služby, zálohy, obnova), README (věta o provozu zdarma na Vercelu).
- Nasazování: buď dál ručně `deploy.sh`, nebo GitHub Actions self-hosted
  runner v CT `web`, který po merge do `main` spustí tentýž skript.

## Rizika

| Riziko | Dopad | Opatření |
| --- | --- | --- |
| **Domácí IP vůči soudům.** Živé dotazy všech uživatelů půjdou ze stejné adresy jako crawler zrcadla; NSS ji už při backfillu blokoval (403). | Živé hledání v NSS (případně jinde) nefunguje pro všechny. | Před fází 5 nechat doběhnout backfill NSS nebo mu snížit tempo; sledovat 403/429; přepínač Živě / Zrcadlo jako záloha; krajní možnost je odchozí provoz ke zdrojům přes levný VPS. |
| Endpoint bez přihlášení po chybě v konfiguraci. | Veřejně otevřené nástroje. | 0.1 + smoke v `deploy.sh` kontroluje 401 bez tokenu. |
| Cloudflare zastaví MCP klienty jako boty. | Konektory nefungují, web ano. | Fáze 2 bod 3; ověřeno skutečným konektorem před přepnutím. |
| Výpadek proudu, internetu nebo notebooku. | Celá služba dole (na Vercelu se nestávalo). | Fáze 3 bod 5, externí dohled; Vercel jako studená záloha do konce fáze 6. Přijaté riziko nekomerční služby. |
| Ztráta dat uživatelů po poruše disku. | Nevratná. | Záloha mimo stroj a zkouška obnovy jsou podmínkou fáze 6. |
| Zaplnění thin poolu. | Poškození dat všech CT. | Dohled `lvs`, malý disk CT `web`, rotace vydání. |
| Build vyčerpá paměť. | Nasazení selže, běžící verze zůstane. | `deploy.sh` přepíná až po úspěšném buildu a smoke. |
| Veřejná služba v domácí síti. | Po kompromitaci aplikace přístup do LAN. | Neprivilegovaný CT, zpevněný unit; do budoucna oddělit CT `web` od LAN (jen `vmbr1` + odchozí NAT). |

## Pořadí a odhad

| Fáze | Práce | Dopad na uživatele |
| --- | --- | --- |
| 0 kód | 1 večer | žádný |
| 1 kontejner | 1 večer | zrcadlo pár sekund (restart `pg`) |
| 2 tunel | 1–2 h | žádný |
| 3 provoz | 1 večer | žádný |
| 4 generálka | 1–2 h | žádný |
| 5 přepnutí | 15 min + týden sledování | žádný |
| 6 databáze | 1 večer přípravy + ~15 min okno | nahrávání na pár minut vypnuté |
| 7 úklid | 1 večer | žádný |
