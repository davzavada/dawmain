# Monitoring domén .cz a .sk

Lokální aplikace, která v nastaveném období (měsíčně, týdně nebo denně) stáhne
oficiální seznamy registrovaných domén **.cz** (CZ.NIC) a **.sk** (SK-NIC),
najde **nově registrované domény** obsahující tvoje klíčová slova – včetně
překlepů a vizuálně podobných zápisů (typosquatting) – a vytvoří přehledný
**HTML report**. Běží bez admin práv a nic neinstaluje do systému.

Podrobný návrh řešení a zdůvodnění: [navrh.md](navrh.md).

## Nejrychlejší zprovoznění: MonitoringDomen.exe (nic se neinstaluje)

1. Stáhni **MonitoringDomen.exe** z
   [Releases → exe-latest](https://github.com/davzavada/dawmain/releases/tag/exe-latest)
   (sestavuje se automaticky GitHub Actions z tohoto repozitáře).
2. Zkopíruj ho do vlastní složky, např. `Dokumenty\MonitoringDomen`
   (aplikace si vedle sebe vytváří `config.json`, `data\` a `reporty\`).
3. Spusť dvojklikem – otevře se **okno aplikace**. Při úplně prvním spuštění
   může Windows SmartScreen zobrazit varování (nepodepsaná aplikace):
   klikni **Další informace → Přesto spustit**. Admin práva nejsou potřeba.
4. V okně:
   - přidej **klíčová slova** (políčko + „Přidat“),
   - tlačítkem **Ověřit zdroje** zkontroluj stahování dat
     (`.sk` má fungovat hned; pro `.cz` viz [Zdroj dat pro .cz](#zdroj-dat-pro-cz)),
   - **Spustit teď** provede první běh – uloží **výchozí stav** (ukáže všechny
     už existující domény s klíčovými slovy; od dalšího běhu se hlásí jen nové
     registrace) a otevře report,
   - **Naplánovat automatiku** zaregistruje úlohu Plánovače úloh pro
     přihlášeného uživatele (bez admin práv); když je počítač v naplánovaný
     čas vypnutý, úloha doběhne po nejbližším zapnutí.

Kdyby přísný firemní antivir odmítl spustit nepodepsané .exe, použij záložní
variantu `.pyz` níže (vyžaduje jen Python, také bez admin práv).

## Záložní varianta: monitoring-domen.pyz (potřebuje Python)

Python 3.9+ se instaluje **bez admin práv**: instalátor z
<https://www.python.org/downloads/>, **nezaškrtávej** „Use admin privileges…“,
**zaškrtni** „Add python.exe to PATH“, klikni **Install Now**. Nouzová
varianta úplně bez instalace: „Windows embeddable package“ (ZIP).

1. Zkopíruj `monitoring-domen.pyz` (z Releases nebo `dist/`) do vlastní složky.
2. V příkazovém řádku v té složce:

   ```
   py monitoring-domen.pyz gui                    otevře stejné okno jako .exe
   py monitoring-domen.pyz pridej-slovo skoda     ...nebo ovládej příkazy
   py monitoring-domen.pyz over-zdroje
   py monitoring-domen.pyz                        běh (funguje i dvojklik)
   py monitoring-domen.pyz nastav-planovac        automatické spouštění
   ```

## Zprovoznění – z repozitáře (pro vývoj)

Stáhni celý repozitář, pak stačí dvojklik na `run.bat` (spustí běh) nebo
`nastav-planovac.bat` (zaregistruje úlohu). Všechny příkazy níže fungují
i jako `run.bat <příkaz>`, případně `python -m monitor <příkaz>`.
Jednosouborovou distribuci sestavíš příkazem `python vytvor-distribuci.py`;
`MonitoringDomen.exe` sestavuje workflow GitHub Actions (viz
`.github/workflows/sestaveni.yml`).

Pozn.: okenní `.exe` nemá konzoli – textové příkazy v něm fungují, ale bez
výpisů. Pro práci z příkazové řádky použij `.pyz`.

## Klíčová slova

```
py monitoring-domen.pyz slova                        vypíše nastavená slova
py monitoring-domen.pyz pridej-slovo skoda           přidá slovo
py monitoring-domen.pyz pridej-slovo cez --bez-preklepu   bez hlídání překlepů
py monitoring-domen.pyz odeber-slovo skoda           odebere slovo
```

- Slova smí obsahovat diakritiku („škoda“ najde i `skoda`).
- Překlepy se hlídají až od 5 znaků délky slova; u krátkých či problémových
  slov je vypni volbou `--bez-preklepu` (méně falešných poplachů).
- Známé neškodné domény (třeba vlastní) přidej do `ignorovat_domeny`
  v `config.json`.
- Běžná česká slova, která se náhodou trefí do překlepu (`skola` vs `skoda`),
  patří do pole **Nehlásit jako překlep** v okně aplikace (`stoplist`
  v `config.json`).

### Jak číst report

Report je rozdělený na dvě části:

- **Vysoká shoda** – klíčové slovo je v názvu obsažené přímo nebo jen jinak
  zapsané (diakritika, pomlčka, záměna podobných znaků). Tyhle projdi vždy.
- **Možné překlepy** – název se liší o jeden až dva znaky. Sem spadají
  skutečné typosquaty (`raifeisenbank.cz`, `eznam.cz`), ale i náhodné shody
  s běžnými slovy. Co je neškodné, přidej do stoplistu nebo ignorovaných domén.

## Období monitoringu

V `config.json` nastav klíč `"obdobi"`:

| hodnota | běh | značka reportu |
|---|---|---|
| `"mesicne"` (výchozí) | 1× měsíčně (den a čas dle `"planovac"`) | `2026-08` |
| `"tydne"` | každé pondělí | `2026-W32` |
| `"denne"` | každý den | `2026-08-05` |

Po změně období spusť znovu `nastav-planovac`, aby se přeplánovala úloha.
Ruční běh za konkrétní období: `py monitoring-domen.pyz --obdobi 2026-07`,
přepočítání už proběhlého období přidej `--znovu`.

## Výstupy

- `reporty\<značka>.html` – report za období, `reporty\index.html` – přehled,
- `data\` – stažené snapshoty seznamů (gzip), databáze běhů a `monitor.log`.

## Odkud se berou data

| TLD | Zdroje |
|---|---|
| **.sk** | úplný seznam SK-NIC + feed nově registrovaných domén |
| **.cz** | feed nově registrovaných domén + ověření překlepových variant přes RDAP CZ.NIC |

**Proč u .cz není seznam.** CZ.NIC – na rozdíl od SK-NIC – hromadný seznam
registrovaných domén nezveřejňuje. Veřejný je jen dotaz na *konkrétní* doménu
(RDAP/WHOIS); vyhledávací rozhraní registru vrací `501 Not Implemented`.
Není to opomenutí: smluvní přístup k zóně CZ.NIC v roce 2011 zrušil a technický
obchvat zavřel nasazením NSEC3. Podrobně v [navrh.md](navrh.md).

Proto se `.cz` skládá ze dvou zdrojů, které se doplňují:

- **feed nově registrovaných domén** ([hagezi/nrd](https://github.com/hagezi/nrd),
  data Stamus Labs) – pokrývá klouzavých **35 dnů** a najde i doménu, jejíž
  jméno bychom neuhodli (`autoskoda-plzen.cz`). Zachytí zhruba polovinu nových
  `.cz` registrací.
- **RDAP CZ.NIC** – ověří vygenerované překlepové varianty klíčových slov;
  najde i doménu zaregistrovanou „do šuplíku“ bez webu. Kvůli limitu registru
  (1 dotaz/s) trvá tahle část jednotky minut.

Kdyby CZ.NIC seznam někdy poskytl, stačí jeho adresu vložit v GUI do pole
**Seznam .cz z URL** (nebo v `config.json` do `zdroje.cz.urls`) – zapojí se
automaticky. Požádat lze na `podpora@nic.cz` nebo datovou schránkou `h4axdn8`.

### Jak často spouštět

Aplikace si pamatuje každou doménu, kterou kdy viděla, a hlásí jen dosud
neviděné – nevadí tedy, když běh vyjde na 28 nebo 33 dnů, ani když jeden
vynecháš. Jediné omezení: **feed sahá 35 dnů zpět**, takže při delší pauze
část registrací unikne. Aplikace na to v takovém případě upozorní v logu.

## Řešení potíží

- **„Python nebyl nalezen“** – nainstaluj Python postupem výše (bez admin
  práv) a spusť znovu.
- **Stahování selhává (403 apod.)** – některé servery blokují neznámé
  programy; do `config.json` přidej klíč `"user_agent"` s hodnotou běžného
  prohlížeče, např.
  `"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"`.
  Firemní proxy se použije automaticky ze systémového nastavení Windows.
- **„URL vrací webovou stránku (HTML)“** – zadaná adresa vede na stránku,
  ne na datový soubor; otevři ji v prohlížeči a zkopíruj přímý odkaz na
  soubor.
- **„nepodařilo se najít žádnou doménu“** – formát souboru se změnil;
  chybová hláška ukáže první řádky, podle nich lze parser snadno upravit.

## Pro vývoj

```
python -m unittest discover -s tests    testy (bez sítě, nad vzorky dat)
python vytvor-distribuci.py             sestaví dist/monitoring-domen.pyz
```

Kód je čistý Python 3.9+ bez závislostí (jen standardní knihovna).
