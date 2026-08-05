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
- distribuce jako **jeden lokální soubor** (`monitoring-domen.pyz`, viz §5),
- klíčová slova i období monitoringu (měsíčně/týdně/denně) si uživatel
  **nastavuje sám** – slova příkazy `pridej-slovo`/`odeber-slovo`/`slova`,
  období v `config.json`.

## 2. Datové zdroje

### 2.1 Doména .sk – vyřešeno

SK-NIC (oficiální správce registru .sk) publikuje **denně aktualizovaný úplný seznam všech
registrovaných .sk domén**, volně ke stažení bez registrace:

- soubor: `https://sk-nic.sk/subory/domains.txt`
- formát: textový, hodnoty oddělené středníkem (doména; registrátor; …), kódování ISO-8859-2
- odkazovaný ze stránky „Zoznam všetkých registrovaných domén“ na webu sk-nic.sk

To je ideální zdroj: oficiální, úplný a zadarmo. Měsíční srovnání dvou stažení dá přesnou
množinu nově registrovaných domén.

### 2.2 Doména .cz – k doověření při prvním spuštění

CZ.NIC provozuje otevřená data a statistické rozhraní (stats.nic.cz), to však poskytuje
**agregované statistiky**, nikoli jmenný seznam. Zda CZ.NIC aktuálně publikuje i hromadný
**seznam registrovaných domén** ke stažení, se z prostředí, kde tento návrh vznikal, nepodařilo
ověřit (web nic.cz blokoval automatizovaný přístup). Proto je zdroj pro .cz řešen konfigurovatelně
a návrh počítá s těmito variantami v tomto pořadí:

1. **Otevřená data CZ.NIC** – při prvním spuštění ověřit na `https://www.nic.cz/` (sekce
   Otevřená data) a v Národním katalogu otevřených dat `https://data.gov.cz/` (hledat
   „CZ.NIC“). Pokud soubor existuje, stačí jeho URL vložit do `config.json` – aplikace si
   s běžnými formáty (prostý seznam, CSV) poradí automaticky.
2. **Dotaz na CZ.NIC** – pokud otevřený seznam neexistuje, požádat o přístup k datům
   (podpora@nic.cz); CZ.NIC historicky poskytuje data registru na základě smlouvy
   (např. pro výzkum či oprávněný zájem – ochrana ochranných známek je legitimní důvod).
3. **Záložní režim RDAP (zabudovaný v aplikaci)** – aplikace vygeneruje z klíčových slov
   **kandidátní názvy** (slovo samotné, s předponami/příponami, s pomlčkami a překlepové
   varianty), levně je předfiltruje přes DNS a existující jména ověří přes oficiální rozhraní
   `rdap.nic.cz` (šetrně, s prodlevou mezi dotazy). Nová jména mezi měsíci = nové registrace.
   *Omezení:* nezachytí klíčové slovo uvnitř delšího názvu (`autoskoda-plzen.cz`) ani
   registrované, ale nedelegované domény.
4. **Neoficiální agregátory** (zonefiles.io, domains-monitor.com apod.) – existují, ale jsou
   placené a neoficiální; v souladu se zadáním jen jako poslední možnost, návrh je nevyužívá.

### 2.3 Princip detekce nových domén

Každý měsíc se stáhne úplný aktuální seznam (snapshot) a porovná se s uloženým snapshotem
z minulého běhu: **nové domény = aktuální množina − minulá množina**. První běh nemá s čím
porovnávat, proto vytvoří **výchozí stav** – report všech *už existujících* domén odpovídajících
klíčovým slovům (užitečné samo o sobě: ukáže současnou situaci kolem značky).

Známé omezení: doména zaregistrovaná a zase zrušená mezi dvěma běhy unikne. Pro měsíční
monitoring značky je to přijatelné; kdo chce jemnější rozlišení, přepne v `config.json`
klíč `obdobi` na `tydne` či `denne` – běhy, značky reportů i úloha plánovače se
přizpůsobí automaticky.

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

Ochrana proti falešným poplachům:

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
monitor/
  __main__.py          orchestrace běhů + příkazy (over-zdroje, slova, planovač…)
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

### 5.1 Distribuce: jeden lokální soubor

Aplikace se šíří jako **jediný soubor `monitoring-domen.pyz`** (formát Python
zipapp ze standardní knihovny). Stačí ho zkopírovat do libovolné složky;
konfiguraci, data i reporty si vytváří vedle sebe, smazáním složky je
„odinstalováno“. Na počítači s Pythonem z python.org funguje i **dvojklik**
(přípona .pyz je asociovaná se spouštěčem `py`). Distribuci sestavuje
`python vytvor-distribuci.py`.

Zvažované .exe (PyInstaller) bylo zamítnuto záměrně: nepodepsané .exe soubory
na firemních počítačích často blokuje SmartScreen/antivir (PyInstaller je
známý falešnými poplachy) a nešlo by je sestavit bez dalších závislostí.
Zipapp řeší totéž bez těchto rizik – jediná podmínka je nainstalovaný Python
(bez admin práv, viz níže).

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
