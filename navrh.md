# Návrh: měsíční monitoring nově registrovaných domén .cz a .sk podle klíčových slov

## 1. Cíl

Jednou měsíčně zjistit, jaké **nové domény** obsahující zadaná klíčová slova (název značky,
firmy, produktu…) byly zaregistrovány pod národními doménami **.cz** a **.sk** – včetně
překlepových a vizuálně podobných variant (typosquatting). Výstupem je přehledný **HTML
report** uložený lokálně.

Klíčová omezení zadání:

- aplikace běží **lokálně na běžném počítači s Windows**,
- **nevyžaduje žádná admin oprávnění** – ani k instalaci, ani k provozu,
- data pocházejí **z oficiálních zdrojů** (správci registrů CZ.NIC a SK-NIC),
- distribuce jako **jeden lokální soubor bez jakékoli instalace**
  (`MonitoringDomen.exe` s grafickým rozhraním; záložně `monitoring-domen.pyz`
  pro počítače s Pythonem – viz §5),
- klíčová slova i období monitoringu (měsíčně/týdně/denně) si uživatel
  **nastavuje sám** – v okně aplikace, případně příkazy
  `pridej-slovo`/`odeber-slovo`/`slova` a v `config.json`.

## 2. Datové zdroje

### 2.1 Doména .sk – vyřešeno

SK-NIC (oficiální správce registru .sk) publikuje **denně aktualizovaný úplný seznam všech
registrovaných .sk domén**, volně ke stažení bez registrace:

- soubor: `https://sk-nic.sk/subory/domains.txt`
- formát: textový, hodnoty oddělené středníkem (doména; registrátor; …), kódování ISO-8859-2
- odkazovaný ze stránky „Zoznam všetkých registrovaných domén“ na webu sk-nic.sk

To je ideální zdroj: oficiální, úplný a zadarmo. Měsíční srovnání dvou stažení dá přesnou
množinu nově registrovaných domén.

### 2.2 Doména .cz – seznam neexistuje

CZ.NIC hromadný seznam registrovaných domén **nezveřejňuje a záměrně neposkytuje**:

- Zóna `.cz` bývala dostupná smluvně (AXFR); v roce 2011 správní rada CZ.NIC
  všechny smlouvy vypověděla a nařídila zlikvidovat archivy (kauza KRAXNET).
- Technický obchvat přes DNSSEC zone-walking zavřelo nasazení **NSEC3**.
- RDAP registru umí jen dotaz na konkrétní jméno – vyhledávací endpointy podle
  RFC 9082 vracejí **HTTP 501 Not Implemented** (ověřeno ve zdrojovém kódu
  `CZ-NIC/fred-rdap`).
- DNS crawler CZ.NIC tato data má, ale politika výslovně vylučuje jejich
  poskytnutí třetím stranám; `stats.nic.cz` i Domain Report jsou jen agregace.
- Průzkum GitHubu potvrdil totéž: katalogizační projekty (`jschauma/tld-zoneinfo`,
  `jschauma/zonecount`) vedou `.cz` jako „name count only“, zatímco `.sk` jako
  skutečný seznam jmen. Žádný veřejný projekt seznam `.cz` domén nemá.

Monitoring `.cz` proto stojí na dvou zdrojích, které se navzájem doplňují:

**a) Feed nově registrovaných domén** – projekt
[hagezi/nrd](https://github.com/hagezi/nrd) (data Stamus Labs Open NRD)
publikuje seznamy nově registrovaných domén včetně `.cz`, bez klíče
a registrace:

```
https://raw.githubusercontent.com/hagezi/nrd/main/domains/nrd7.txt
                                                        nrd14-8.txt
                                                        nrd21-15.txt
                                                        nrd28-22.txt
                                                        nrd35-29.txt
```

Pět oken pokrývá klouzavých **35 dnů**. Ověřeno 5. 8. 2026: `nrd7` obsahuje
5 331 `.cz` domén, granularita je doména 2. řádu, aktualizace denní,
dlouho registrované domény (`seznam.cz`, `alza.cz`, `nic.cz`) v seznamu nejsou.
Feed pokrývá i `.sk` (4 126 domén za 14 dnů), proto se používá pro obě TLD.

*Omezení:* ~526 nových `.cz` denně oproti reálným ~850–1 000, tedy zhruba
**50–60 % pokrytí**, a jednotlivá okna jsou naplněná nepravidelně. Proto se
vždy stahuje všech pět oken a výsledek se porovnává s vlastní historií.

**b) RDAP CZ.NIC** – pro každé klíčové slovo se vygenerují překlepové varianty
a ověří se dotazem `https://rdap.nic.cz/domain/<jméno>`. Najde i doménu
zaregistrovanou bez webu, kterou feed nezachytí. Limit registru je od 11/2024
1 dotaz/s na IP, prodleva je proto 1,2 s.

**Prověřeno a zamítnuto:** crt.sh (Certificate Transparency) – od 7/2026 zrušil
hledání podřetězce a snížil limit na 5 dotazů/min; Domains Project
(`tb0hdan/domains`) – 7,3 mil. `.cz` jmen, ale poslední aktualizace 10/2023
a jde o crawl, ne registrace; Tranco/Majestic – jen TOP 1 mil.; whoisds.com –
pouze gTLD; NSEC3 zone-walking – vyloučeno, zátěž kritické infrastruktury
a porušení podmínek CZ.NIC.

**Oficiální cesta k datům:** písemná žádost s úředně ověřeným podpisem nebo
datovou schránkou (`h4axdn8`), s odůvodněním účelu; CZ.NIC může zpoplatnit
i odmítnout. Data z registru poskytuje soudům a rozhodcům v ADR sporu – pro
majitele značky tedy vede cesta přes zahájení sporu, ne přes žádost o dataset.

### 2.3 Princip detekce nových domén

Aplikace si vede **trvalou evidenci všech domén, které kdy viděla** (tabulka
`videne_domeny`). Za novou se považuje doména, která v evidenci ještě není –
bez ohledu na to, který zdroj ji nahlásil a jak dlouhá byla mezera mezi běhy.
Výsledky jednotlivých zdrojů se prostě sjednotí.

Tenhle přístup je odolnější než porovnávání dvou snapshotů: zdroje mají různou
povahu (úplný seznam × výřez posledních 35 dnů × ověřená jména), různá období
běhů nevadí a vynechaný běh nic nerozbije.

První běh s úplným seznamem (`.sk`) přirozeně označí za nové všechny domény
registru. Report se v takovém případě označí jako **výchozí stav** – je to
užitečný vstupní audit toho, co kolem značky existuje už teď.

Známá omezení:

- Feed nových domén sahá **35 dnů zpět**. Při delší pauze mezi běhy část
  registrací unikne – aplikace na to upozorní v logu. Proto je doporučená
  frekvence měsíčně (`obdobi` lze přepnout i na `tydne`/`denne`).
- Doména zaregistrovaná a zrušená mezi dvěma běhy může uniknout, pokud ji
  nezachytí ani feed.
- Feed pokrývá zhruba polovinu nových `.cz` registrací (viz 2.2); RDAP vrstva
  tuto mezeru zmenšuje jen pro předvídané varianty.

## 3. Detekce shody s klíčovými slovy

Porovnává se druhá úroveň názvu (bez koncovky). Každý nález je v reportu označen typem shody,
vyhodnocují se v tomto pořadí:

| Typ shody | Příklad pro slovo „skoda“ |
|---|---|
| přesná shoda (podřetězec) | `novaskoda.cz`, `skoda-dily.sk` |
| diakritika / IDN | `xn--koda-f6a.cz` (v prohlížeči `škoda.cz`) |
| vložená pomlčka | `s-koda-servis.cz` |
| záměna znaků (leet/homoglyfy) | `sk0da-dily.cz` (0↔o, 1↔i↔l, rn↔m, vv↔w…) |
| překlep (Levenshteinova vzdálenost) | `skooda-eshop.cz` |

Ochrana proti falešným poplachům – **čeština je tu hlavní problém**. Test na
reálných datech ukázal, že volné klouzavé okno dělá pro slovo „skoda“ 28 nálezů,
z nichž drtivá většina jsou náhody: `autoskola-schejbal.cz`, `vecerniskola.cz`,
`chorvatskoapartmany.cz`, `mikulaskova.cz`, `evahruskova.cz` (škola, autoškola,
Chorvatsko, příjmení na -ková). Opatření:

- **Ukotvení na hranici tokenu** – překlepová shoda se uzná jen tam, kde okno
  začíná na začátku názvu nebo za pomlčkou. Squatter píše značku na začátek
  (`skoda-dily`, `moje-skoda`); shoda uprostřed slova je skoro vždy náhoda.
  Na stejných datech to snížilo počet nálezů **z 28 na 5**, aniž zmizel jediný
  skutečný zásah (`raifeisenbank.cz` i `eznam.cz` prošly).
- **Stoplist** běžných českých slov (`skola`, `soda`, `sklo`, `servis`…),
  rozšiřitelný uživatelem v okně aplikace. Porovnává se s celým tokenem
  i s nalezeným oknem.
- **Rozdělení reportu** na „vysoká shoda“ (přesná / IDN / pomlčka / záměna znaků)
  a „možné překlepy“ – právník tak nejdřív čte spolehlivou část a fuzzy nálezy
  bere jako podnět k prohlédnutí.
- překlepy se vyhodnocují až od **5 znaků** délky slova (vzdálenost 1), od 8 znaků vzdálenost 2,
- překlepy lze **vypnout u jednotlivého slova** (`"preklepy": false` v config.json),
- **whitelist** `ignorovat_domeny` potlačí známé neškodné domény (např. vlastní),
- klíčová slova smí obsahovat diakritiku – normalizují se stejně jako domény.

Slova spravuje uživatel bez zásahů do JSONu příkazy `pridej-slovo <slovo>
[--bez-preklepu]`, `odeber-slovo <slovo>` a `slova` (výpis); ručně editovat
`config.json` je samozřejmě dál možné.

Výkon: měsíčně přibývá řádově 10–25 tisíc .cz a jednotky tisíc .sk domén; porovnání s desítkami
klíčových slov trvá sekundy. První (výchozí) běh prochází celé seznamy (~1,5 mil. + ~0,5 mil.
domén) a trvá nízké jednotky minut.

## 4. Architektura aplikace

Čistý **Python 3.9+ pouze se standardní knihovnou** – žádné závislosti, žádný `pip`, žádná
instalace do systému. Celá aplikace je jedna složka; smazáním složky je „odinstalováno“.

```
config.json            konfigurace: klíčová slova, whitelist, období, URL zdrojů
run.bat                spuštění dvojklikem (najde nainstalovaný Python)
nastav-planovac.bat    registrace úlohy v Plánovači úloh (bez admin práv)
vytvor-distribuci.py   sestaví jednosouborovou distribuci dist/monitoring-domen.pyz
vstup_exe.py           vstupní bod pro zabalené MonitoringDomen.exe
.github/workflows/     sestaveni.yml - CI: testy + build .exe na windows runneru
monitor/
  __main__.py          orchestrace běhů + příkazy (gui, over-zdroje, slova…)
  gui.py               grafické rozhraní (tkinter): slova, období, zdroje, běh
  zdroje.py            stažení a parsování seznamů (SK-NIC, CZ.NIC, RDAP fallback)
  shoda.py             detekční jádro (normalizace, leet, Levenshtein)
  uloziste.py          SQLite databáze běhů a nálezů + gzip snapshoty
  report.py            generování HTML reportů
  planovac.py          značky období + generování XML úlohy Plánovače
dist/                  monitoring-domen.pyz (jednosouborová distribuce)
data/                  (vzniká za běhu) snapshoty, databáze, log
reporty/               (vzniká za běhu) <značka období>.html + index.html
tests/                 jednotkové a end-to-end testy nad vzorky dat
```

Parser seznamů je záměrně obranný: sám rozpozná oddělovač i sloupec s doménou, přeskočí
hlavičky a komentáře, a při změně formátu vypíše srozumitelnou chybu s ukázkou dat. Stahování
má opakování s exponenciálním čekáním a identifikuje se vlastním User-Agentem.

Uchovávají se snapshoty za posledních 6 měsíců (konfigurovatelné) – lze se tedy vrátit
a přepočítat běh zpětně (`--mesic 2026-07 --znovu`).

## 5. Provoz na Windows bez admin práv

### 5.1 Distribuce: jeden lokální soubor, nic se neinstaluje

Hlavní distribuce je **`MonitoringDomen.exe`** – jediný soubor s grafickým
rozhraním, který nevyžaduje ani Python, ani instalaci, ani admin práva.
Protože windowsovské .exe nejde sestavit lokálně na jiném systému, sestavuje
ho **GitHub Actions workflow na windows runneru** (PyInstaller `--onefile
--windowed`): při každé změně kódu proběhnou testy, build a publikace do
GitHub Releases (značka `exe-latest`). Stačí ho zkopírovat do libovolné
složky; konfiguraci, data i reporty si vytváří vedle sebe, smazáním složky
je „odinstalováno“.

Známá omezení nepodepsaného .exe (nemáme podpisový certifikát):

- SmartScreen při prvním spuštění zobrazí varování → „Další informace →
  Přesto spustit“; admin práva to nevyžaduje,
- přísný firemní antivir může PyInstaller balíčky hlásit falešně pozitivně.

Pro tyto případy existuje **záložní distribuce `monitoring-domen.pyz`**
(formát Python zipapp ze standardní knihovny, sestavuje
`python vytvor-distribuci.py`): potřebuje nainstalovaný Python (bez admin
práv), obsahuje totéž včetně GUI (příkaz `gui`) a antiviry ji neřeší.

### 5.1.1 Grafické rozhraní

Okno (tkinter, součást Pythonu → žádná závislost navíc) pokrývá celý provoz:
správu klíčových slov (přidat/odebrat, per slovo vypnutí překlepů), volbu
období a času běhu, nastavení zdroje .cz (URL otevřených dat / záložní RDAP
režim), tlačítka **Ověřit zdroje**, **Spustit teď** (otevře hotový report),
**Naplánovat automatiku** a **Otevřít poslední report**; průběh se vypisuje
do okna. Dlouhé akce běží ve vedlejším vlákně, okno nezamrzá. Dvojklik na
.exe otevírá rovnou GUI; textové příkazy zůstávají pro pokročilé použití
a pro úlohu plánovače (`--tichy`).

### 5.2 Prostředí a plánování

- **Python**: instalátor z python.org ve výchozím nastavení instaluje jen do profilu uživatele
  („Install Now“ bez zaškrtnutí „Use admin privileges“) – admin práva nejsou potřeba. Nouzová
  varianta úplně bez instalace: „Windows embeddable package“ (ZIP) rozbalený vedle aplikace.
- **Plánování**: příkaz `nastav-planovac` (resp. `nastav-planovac.bat`) vygeneruje definici
  úlohy podle nastaveného období – měsíčně (den a čas dle `config.json`), týdně (pondělí)
  či denně – a zaregistruje ji **pro přihlášeného uživatele** (`schtasks /Create /XML`,
  bez elevace). Úloha má `StartWhenAvailable`, takže když je počítač v naplánovaný čas
  vypnutý, doběhne po nejbližším zapnutí. Aplikace je navíc idempotentní – běh, který už
  v daném období proběhl, se opakovaně nespouští, takže nevadí ani ruční spouštění navíc.
- **Zápis jen do vlastní složky** (data/, reporty/) – žádné zásahy do registrů Windows,
  Program Files ani služeb.
- **Firemní síť**: stahování používá systémové nastavení proxy Windows a certifikáty
  ze systémového úložiště; User-Agent lze v `config.json` přepnout (`user_agent`),
  kdyby server výchozí identifikaci blokoval.

## 6. Bezpečnost, osobní údaje, podmínky užití

- Stahované seznamy obsahují **jen názvy domén** (u .sk navíc identifikátor registrátora) –
  žádné osobní údaje držitelů; z pohledu GDPR je zpracování bezproblémové.
- Údaje o držiteli konkrétní podezřelé domény se dohledávají ručně přes odkazy v reportu
  (RDAP/WHOIS) – jednotlivé dotazy jsou v souladu s podmínkami registrů.
- Aplikace dodržuje šetrné chování vůči infrastruktuře registrů: jedno stažení měsíčně,
  v RDAP režimu prodleva mezi dotazy (výchozí 1 s, konfigurovatelné).
- Doporučení: před nasazením zkontrolovat podmínky užití seznamu SK-NIC a případných
  otevřených dat CZ.NIC (typicky licence CC-BY či obdobná – nutno uvádět zdroj).

## 7. Vědomě odložená rozšíření

Probráno a zatím **záměrně vynecháno** (lze doplnit později):

- sledování stavu konkrétních vyjmenovaných domén (watchlist volná/registrovaná),
- notifikace webhookem či e-mailem po doběhnutí reportu,
- další TLD (.eu, .com…) – architektura zdrojů je na to připravená (jeden adaptér na registr),
- obohacení nálezů o datum registrace a držitele z RDAP přímo v reportu.
