"""Vstupní bod: python -m monitor [prikaz] [volby]
(u jednosouborové distribuce: py monitoring-domen.pyz [prikaz] [volby])

Příkazy:
  spustit          (výchozí) provede běh: stáhne seznamy, najde nové domény,
                   vyhodnotí klíčová slova a vygeneruje HTML report
  over-zdroje      jen ověří dostupnost datových zdrojů (vhodné pro 1. spuštění)
  slova            vypíše nastavená klíčová slova
  pridej-slovo     přidá klíčové slovo:  pridej-slovo skoda [--bez-preklepu]
  odeber-slovo     odebere klíčové slovo: odeber-slovo skoda
  planovac-xml     vytvoří XML definici úlohy Plánovače úloh Windows
  nastav-planovac  vytvoří XML a rovnou úlohu zaregistruje (jen Windows,
                   bez admin práv - úloha běží pod přihlášeným uživatelem)
"""

import argparse
import datetime
import json
import logging
import os
import subprocess
import sys

from . import planovac, report, shoda, uloziste, zdroje

log = logging.getLogger("monitor")


def _urci_koren():
    """Složka aplikace: vedle .exe / .pyz souboru, jinak vedle balíčku monitor/."""
    if getattr(sys, "frozen", False):              # zabalené .exe (PyInstaller)
        exe = os.path.abspath(sys.executable)
        return os.path.dirname(exe), None, exe
    balicek = os.path.dirname(os.path.abspath(__file__))
    if os.path.isdir(balicek):
        return os.path.dirname(balicek), None, None
    archiv = os.path.abspath(sys.argv[0])          # běžíme uvnitř .pyz
    return os.path.dirname(archiv), archiv, None


KOREN, ARCHIV_PYZ, ARCHIV_EXE = _urci_koren()

VYCHOZI_CONFIG = {
    "klicova_slova": [],
    "ignorovat_domeny": [],
    "obdobi": "mesicne",
    "planovac": {"den_v_mesici": 2, "cas": "09:30"},
    "zdroje": {
        "sk": {
            "url": "https://sk-nic.sk/subory/domains.txt",
            "kodovani": "iso-8859-2",
        },
        "cz": {
            "rezim": "auto",
            "urls": [],
            "kodovani": "utf-8",
            "_napoveda": [
                "Do 'urls' vlož adresu souboru se seznamem .cz domén z otevřených dat CZ.NIC.",
                "Kde ji najít: https://www.nic.cz/ (sekce Otevřená data) nebo https://data.gov.cz/ (hledej 'CZ.NIC').",
                "Postup je popsán v README.md v sekci 'První spuštění'.",
                "Pokud hromadný seznam není dostupný, nastav 'rezim' na 'rdap' - zapne se záložní kontrola kandidátních jmen přes oficiální rozhraní rdap.nic.cz.",
            ],
        },
    },
    "rdap_fallback": {
        "pripony_predpony": ["e", "moje", "muj", "web", "online", "shop",
                             "eshop", "info", "cz", "sk", "24"],
        "max_kandidatu_na_slovo": 200,
        "prodleva_sekund": 1.0,
    },
    "uchovavat_snapshotu": 6,
    "otevrit_report": True,
}


def _nastav_logovani(slozka_dat: str):
    os.makedirs(slozka_dat, exist_ok=True)
    handlery = [logging.FileHandler(os.path.join(slozka_dat, "monitor.log"),
                                    encoding="utf-8")]
    if sys.stderr is not None:      # okenní .exe nemá konzoli
        handlery.append(logging.StreamHandler())
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s  %(levelname)s  %(message)s",
        handlers=handlery,
    )


def uloz_config(cesta: str, config: dict):
    docasna = cesta + ".tmp"
    with open(docasna, "w", encoding="utf-8") as f:
        json.dump(config, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(docasna, cesta)


def nacti_config(cesta: str) -> dict:
    try:
        with open(cesta, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        uloz_config(cesta, VYCHOZI_CONFIG)
        print("Vytvořen nový konfigurační soubor %s." % cesta)
        return json.loads(json.dumps(VYCHOZI_CONFIG))
    except json.JSONDecodeError as chyba:
        sys.exit("config.json není platný JSON: %s" % chyba)


def _zdroj_sk(config: dict, offline):
    sk = config.get("zdroje", {}).get("sk", {})
    return zdroje.SkNic(
        url=sk.get("url", "https://sk-nic.sk/subory/domains.txt"),
        kodovani=sk.get("kodovani", "iso-8859-2"),
        offline_soubor=offline,
    )


def _zdroj_cz(config: dict, offline):
    cz = config.get("zdroje", {}).get("cz", {})
    if offline or cz.get("rezim", "auto") != "rdap":
        return zdroje.CzNicOpenData(
            urls=cz.get("urls", []),
            kodovani=cz.get("kodovani", "utf-8"),
            offline_soubor=offline,
        )
    fallback = config.get("rdap_fallback", {})
    return zdroje.CzRdapFallback(
        konfigurace_slov=config.get("klicova_slova", []),
        pripony_predpony=fallback.get("pripony_predpony", []),
        max_na_slovo=int(fallback.get("max_kandidatu_na_slovo", 200)),
        prodleva=float(fallback.get("prodleva_sekund", 1.0)),
    )


def spustit_beh(config: dict, sklad: uloziste.Uloziste, volby) -> int:
    """Provede běh pro vybraná TLD; vrací počet TLD, která selhala."""
    if not config.get("klicova_slova"):
        print("Nejsou nastavená žádná klíčová slova - přidej je, např.:\n"
              "  %s pridej-slovo skoda\n"
              "nebo uprav klicova_slova v config.json." % _jak_spustit())
        return 1

    tlds = [volby.jen_tld] if volby.jen_tld else ["cz", "sk"]
    selhani = 0
    zpracovano = False

    for tld in tlds:
        if sklad.beh_existuje(volby.obdobi, tld) and not volby.znovu:
            log.info("Pro .%s už běh za %s proběhl - přeskakuji "
                     "(vynutit lze volbou --znovu).", tld, volby.obdobi)
            continue
        zdroj = (_zdroj_cz(config, volby.offline_cz) if tld == "cz"
                 else _zdroj_sk(config, volby.offline_sk))
        try:
            vysledek = zdroj.stahni()
        except zdroje.ChybaZdroje as chyba:
            log.error("Zdroj .%s selhal: %s", tld, chyba)
            selhani += 1
            continue

        predchozi = sklad.predchozi_beh(volby.obdobi, tld)
        stary_snapshot = sklad.nacti_snapshot(predchozi[1]) if predchozi else None
        if stary_snapshot is None:
            nove = vysledek.domeny
            vychozi_stav = True
            log.info(".%s: první běh, ukládám výchozí stav (%d domén).",
                     tld, len(vysledek.domeny))
        else:
            nove = vysledek.domeny - stary_snapshot
            vychozi_stav = False
            log.info(".%s: %d domén celkem, %d nových od běhu za %s.",
                     tld, len(vysledek.domeny), len(nove), predchozi[0])

        nalezy = shoda.najdi_shody(
            nove, config.get("klicova_slova", []),
            config.get("ignorovat_domeny", []),
        )
        log.info(".%s: %d nálezů podle klíčových slov.", tld, len(nalezy))

        snapshot = sklad.uloz_snapshot(volby.obdobi, tld, vysledek.domeny)
        sklad.uloz_beh(
            obdobi=volby.obdobi, tld=tld,
            spusteno=datetime.datetime.now().isoformat(timespec="seconds"),
            zdroj=vysledek.popis, pocet_domen=len(vysledek.domeny),
            pocet_novych=len(nove), vychozi_stav=vychozi_stav,
            snapshot_soubor=snapshot,
        )
        sklad.uloz_nalezy(volby.obdobi, tld, nalezy, vysledek.registratori)
        zpracovano = True

    sklad.uklid_snapshotu(int(config.get("uchovavat_snapshotu", 6)))

    slozka_reportu = os.path.join(KOREN, "reporty")
    behy = sklad.behy_obdobi(volby.obdobi)
    if not behy:
        log.error("Žádný zdroj se nepodařilo zpracovat, report nevznikl.")
        return selhani or 1
    cesta = report.generuj_report(volby.obdobi, behy,
                                  sklad.nalezy_obdobi(volby.obdobi),
                                  slozka_reportu)
    report.generuj_index(sklad.vsechna_obdobi(), sklad.pocty_nalezu(),
                         slozka_reportu)
    print("\nHotovo. Report: %s" % cesta)

    if (zpracovano and config.get("otevrit_report", True) and not volby.tichy
            and hasattr(os, "startfile")):
        os.startfile(cesta)  # jen Windows: otevře report v prohlížeči
    return selhani


def over_zdroje(config: dict, volby) -> int:
    """Zkusí stáhnout každý zdroj a vypíše výsledek - nic neukládá."""
    chyby = 0
    print("Ověřuji datové zdroje...\n")

    try:
        vysledek = _zdroj_sk(config, volby.offline_sk).stahni()
        print("[OK]  .sk  %s - %d domén" % (vysledek.popis, len(vysledek.domeny)))
    except zdroje.ChybaZdroje as chyba:
        chyby += 1
        print("[CHYBA]  .sk  %s" % chyba)

    cz = config.get("zdroje", {}).get("cz", {})
    if cz.get("rezim", "auto") == "rdap":
        testovaci = zdroje.CzRdapFallback([], [])
        if testovaci._rdap_registrovana("nic.cz"):
            print("[OK]  .cz  rozhraní rdap.nic.cz odpovídá (režim rdap)")
        else:
            chyby += 1
            print("[CHYBA]  .cz  rdap.nic.cz neodpovídá")
    else:
        try:
            vysledek = _zdroj_cz(config, volby.offline_cz).stahni()
            print("[OK]  .cz  %s - %d domén" % (vysledek.popis, len(vysledek.domeny)))
        except zdroje.ChybaZdroje as chyba:
            chyby += 1
            print("[CHYBA]  .cz  %s" % chyba)

    print("\n%s" % ("Vše připraveno, spusť běh: %s" % _jak_spustit()
                    if not chyby else
                    "Některý zdroj nefunguje - postupuj podle README, "
                    "sekce 'První spuštění'."))
    return chyby


def _jak_spustit() -> str:
    if ARCHIV_EXE:
        return '"%s"' % os.path.basename(ARCHIV_EXE)
    if ARCHIV_PYZ:
        return 'py "%s"' % os.path.basename(ARCHIV_PYZ)
    return "run.bat (nebo python -m monitor)"


def sprava_slov(config: dict, cesta_configu: str, volby) -> int:
    slova = config.setdefault("klicova_slova", [])

    if volby.prikaz == "slova":
        if not slova:
            print("Žádná klíčová slova nejsou nastavená.")
        else:
            print("Nastavená klíčová slova:")
            for polozka in slova:
                priznak = "" if polozka.get("preklepy", True) else "  (bez překlepů)"
                print("  - %s%s" % (polozka.get("slovo", "?"), priznak))
        return 0

    if not volby.hodnota:
        print("Chybí slovo - použití: %s %s <slovo>" % (_jak_spustit(), volby.prikaz))
        return 1
    slovo = volby.hodnota.strip().lower()
    normalizovane = shoda.normalizuj_slovo(slovo)

    if volby.prikaz == "pridej-slovo":
        if any(shoda.normalizuj_slovo(p.get("slovo", "")) == normalizovane
               for p in slova):
            print("Slovo „%s“ už je nastavené." % slovo)
            return 0
        slova.append({"slovo": slovo, "preklepy": not volby.bez_preklepu})
        uloz_config(cesta_configu, config)
        print("Přidáno klíčové slovo „%s“%s." %
              (slovo, " (bez hlídání překlepů)" if volby.bez_preklepu else ""))
        return 0

    zbyla = [p for p in slova
             if shoda.normalizuj_slovo(p.get("slovo", "")) != normalizovane]
    if len(zbyla) == len(slova):
        print("Slovo „%s“ v konfiguraci není." % slovo)
        return 1
    config["klicova_slova"] = zbyla
    uloz_config(cesta_configu, config)
    print("Odebráno klíčové slovo „%s“." % slovo)
    return 0


def sprava_planovace(config: dict, volby) -> int:
    if ARCHIV_EXE:
        spousteni = '"%s" --tichy' % ARCHIV_EXE
    elif ARCHIV_PYZ:
        spousteni = 'py "%s" --tichy' % ARCHIV_PYZ
    else:
        spousteni = '"%s" --tichy' % os.path.join(KOREN, "run.bat")
    try:
        xml = planovac.vytvor_xml_ulohy(KOREN, config, spousteni)
    except ValueError as chyba:
        print("Chyba v konfiguraci plánovače: %s" % chyba)
        return 1
    cesta = volby.vystup or os.path.join(KOREN, "data", "uloha-planovace.xml")
    os.makedirs(os.path.dirname(cesta) or ".", exist_ok=True)
    with open(cesta, "w", encoding="utf-16") as f:
        f.write(xml)
    popis = planovac.popis_rozvrhu(
        config.get("obdobi", "mesicne"),
        int(config.get("planovac", {}).get("den_v_mesici", 2)),
        str(config.get("planovac", {}).get("cas", "09:30")))
    print("XML definice úlohy uložena: %s (rozvrh: %s)" % (cesta, popis))

    if volby.prikaz == "planovac-xml":
        print('Registrace: schtasks /Create /TN "MonitoringDomen" /XML "%s" /F' % cesta)
        return 0
    if os.name != "nt":
        print("Registrace úlohy funguje jen na Windows.")
        return 1
    vysledek = subprocess.run(
        ["schtasks", "/Create", "/TN", "MonitoringDomen", "/XML", cesta, "/F"])
    if vysledek.returncode == 0:
        print("\nHotovo. Úloha „MonitoringDomen“ poběží: %s.\n"
              "Když bude počítač v tu dobu vypnutý, spustí se po nejbližším "
              "zapnutí.\nZrušení: schtasks /Delete /TN MonitoringDomen /F" % popis)
        return 0
    print("Vytvoření úlohy selhalo (kód %d)." % vysledek.returncode)
    return 1


def main(argv=None):
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    parser = argparse.ArgumentParser(
        prog="python -m monitor",
        description="Monitoring nových domén .cz a .sk podle klíčových slov.",
    )
    parser.add_argument("prikaz", nargs="?", default="spustit",
                        choices=["spustit", "gui", "over-zdroje", "slova",
                                 "pridej-slovo", "odeber-slovo",
                                 "planovac-xml", "nastav-planovac"],
                        help="co udělat (výchozí: spustit; "
                             "zabalené .exe bez argumentů otevírá gui)")
    parser.add_argument("hodnota", nargs="?",
                        help="hodnota příkazu (např. klíčové slovo)")
    parser.add_argument("--obdobi", metavar="ZNACKA",
                        help="značka období běhu (RRRR-MM, RRRR-WTT nebo "
                             "RRRR-MM-DD; výchozí: aktuální podle config.json)")
    parser.add_argument("--znovu", action="store_true",
                        help="přepsat už existující běh za dané období")
    parser.add_argument("--jen-tld", choices=["cz", "sk"],
                        help="zpracovat jen jedno TLD")
    parser.add_argument("--offline-cz", metavar="SOUBOR",
                        help="místo stahování použít lokální soubor se seznamem .cz")
    parser.add_argument("--offline-sk", metavar="SOUBOR",
                        help="místo stahování použít lokální soubor se seznamem .sk")
    parser.add_argument("--bez-preklepu", action="store_true",
                        help="u pridej-slovo: nehlídat překlepové varianty")
    parser.add_argument("--vystup", metavar="SOUBOR",
                        help="u planovac-xml: kam uložit XML definici úlohy")
    parser.add_argument("--tichy", action="store_true",
                        help="neotvírat report v prohlížeči (pro plánovač)")
    argumenty = list(argv) if argv is not None else sys.argv[1:]
    if ARCHIV_EXE and not argumenty:
        argumenty = ["gui"]        # dvojklik na .exe otevře grafické rozhraní
    volby = parser.parse_args(argumenty)

    cesta_configu = os.path.join(KOREN, "config.json")
    config = nacti_config(cesta_configu)
    if config.get("user_agent"):
        zdroje.UZIVATELSKY_AGENT = str(config["user_agent"])

    typ_obdobi = config.get("obdobi", "mesicne")
    if typ_obdobi not in planovac.OBDOBI:
        sys.exit("Neplatné 'obdobi' v config.json: %r (povolené: %s)"
                 % (typ_obdobi, ", ".join(planovac.OBDOBI)))
    if not volby.obdobi:
        volby.obdobi = planovac.znacka_obdobi(typ_obdobi)
    elif not planovac.platna_znacka(volby.obdobi):
        parser.error("--obdobi musí být RRRR-MM, RRRR-WTT nebo RRRR-MM-DD "
                     "(např. 2026-08, 2026-W32, 2026-08-05)")

    if volby.prikaz == "gui":
        from . import gui
        return gui.spust_gui(sys.modules[__name__])
    if volby.prikaz in ("slova", "pridej-slovo", "odeber-slovo"):
        return sprava_slov(config, cesta_configu, volby)
    if volby.prikaz in ("planovac-xml", "nastav-planovac"):
        return sprava_planovace(config, volby)

    _nastav_logovani(os.path.join(KOREN, "data"))
    if volby.prikaz == "over-zdroje":
        navrat = over_zdroje(config, volby)
    else:
        sklad = uloziste.Uloziste(os.path.join(KOREN, "data"))
        try:
            navrat = spustit_beh(config, sklad, volby)
        finally:
            sklad.zavri()

    # Při dvojkliku na .pyz by se okno konzole hned zavřelo - počkáme.
    if (ARCHIV_PYZ and os.name == "nt" and not volby.tichy
            and sys.stdin and sys.stdin.isatty()):
        try:
            input("\nPokračuj klávesou Enter...")
        except EOFError:
            pass
    return navrat


if __name__ == "__main__":
    sys.exit(main())
