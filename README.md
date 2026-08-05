# Monitoring domén .cz a .sk

Lokální aplikace, která v nastaveném období (měsíčně, týdně nebo denně) stáhne
oficiální seznamy registrovaných domén **.cz** (CZ.NIC) a **.sk** (SK-NIC),
najde **nově registrované domény** obsahující tvoje klíčová slova – včetně
překlepů a vizuálně podobných zápisů (typosquatting) – a vytvoří přehledný
**HTML report**. Běží bez admin práv a nic neinstaluje do systému.

Podrobný návrh řešení a zdůvodnění: [navrh.md](navrh.md).

## Co je potřeba

- Windows 10/11 (funguje i na macOS/Linux),
- Python 3.9 nebo novější – **instalace nevyžaduje admin práva**:
  1. stáhni instalátor z <https://www.python.org/downloads/>,
  2. **nezaškrtávej** „Use admin privileges when installing py launcher“,
     **zaškrtni** „Add python.exe to PATH“ a klikni **Install Now**
     (instaluje se jen do tvého profilu),
  3. nouzová varianta úplně bez instalace: „Windows embeddable package“ (ZIP)
     rozbalený do složky aplikace.

## Zprovoznění – jednosouborová verze (doporučeno)

1. Zkopíruj `dist/monitoring-domen.pyz` do vlastní složky, např.
   `Dokumenty\MonitoringDomen` (aplikace si vedle sebe vytváří `config.json`,
   `data\` a `reporty\`).
2. Otevři v té složce příkazový řádek a přidej klíčová slova:

   ```
   py monitoring-domen.pyz pridej-slovo skoda
   py monitoring-domen.pyz pridej-slovo mojefirma
   ```

3. Ověř datové zdroje: `py monitoring-domen.pyz over-zdroje`
   – `.sk` má fungovat hned; pro `.cz` viz [Zdroj dat pro .cz](#zdroj-dat-pro-cz).
4. První běh: `py monitoring-domen.pyz` (nebo dvojklik na soubor `.pyz`).
   První běh uloží **výchozí stav** – ukáže všechny už existující domény
   s klíčovými slovy; od dalšího běhu se hlásí jen nové registrace.
5. Automatické spouštění: `py monitoring-domen.pyz nastav-planovac`
   – zaregistruje úlohu Plánovače úloh pro přihlášeného uživatele
   (bez admin práv). Když je počítač v naplánovaný čas vypnutý, úloha
   doběhne po nejbližším zapnutí.

## Zprovoznění – z repozitáře

Stáhni celý repozitář, pak stačí dvojklik na `run.bat` (spustí běh) nebo
`nastav-planovac.bat` (zaregistruje úlohu). Všechny příkazy níže fungují
i jako `run.bat <příkaz>`, případně `python -m monitor <příkaz>`.
Jednosouborovou distribuci sestavíš příkazem `python vytvor-distribuci.py`.

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

## Zdroj dat pro .cz

Seznam `.sk` domén poskytuje SK-NIC přímo (nastaveno předem). U `.cz` je
potřeba při prvním zprovoznění doplnit adresu souboru se seznamem domén
z otevřených dat CZ.NIC:

1. Otevři <https://www.nic.cz/> (sekce **Otevřená data**), případně
   národní katalog <https://data.gov.cz/> a vyhledej „CZ.NIC“.
2. Najdi dataset se **seznamem registrovaných domén** a zkopíruj přímý odkaz
   na datový soubor (CSV/TXT) do `config.json` → `zdroje.cz.urls`.
3. Ověř příkazem `over-zdroje`.

Pokud CZ.NIC hromadný seznam nenabízí, nastav v `config.json`
`zdroje.cz.rezim` na `"rdap"` – aplikace pak nové registrace zjišťuje
kontrolou kandidátních jmen (slovo + předpony/přípony + překlepy) přes
oficiální rozhraní `rdap.nic.cz`. Tento režim nezachytí klíčové slovo
uvnitř delších názvů; podrobnosti v [navrh.md](navrh.md). Další možnost je
požádat CZ.NIC o poskytnutí dat (podpora@nic.cz).

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
