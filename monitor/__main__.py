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
    "stoplist": [],
    "obdobi": "mesicne",
    "planovac": {"den_v_mesici": 2, "cas": "09:30"},
    "zdroje": {
        "sk": {
            "seznam": True,
            "nrd": True,
            "url": "https://sk-nic.sk/subory/domains.txt",
            "kodovani": "iso-8859-2",
        },
        "cz": {
            "rdap": True,
            "nrd": True,
            "urls": [],
            "kodovani": "utf-8",
            "_napoveda": [
                "CZ.NIC hromadný seznam .cz domén nezveřejňuje, proto se .cz skládá ze dvou zdrojů:",
                "  nrd  = feed nově registrovaných domén (najde i jména, která bychom neuhodli),",
                "  rdap = ověření vygenerovaných překlepových variant přes oficiální rdap.nic.cz.",
                "Kdyby CZ.NIC seznam někdy poskytl, stačí jeho adresu vložit do 'urls'.",
            ],
        },
        "nrd": {
            "zaklad": zdroje.NRD_ZAKLAD,
            "okna": list(zdroje.NRD_OKNA),
            "_napoveda": [
                "Feed nově registrovaných domén (projekt hagezi/nrd, data Stamus Labs).",
                "Pět oken pokrývá klouzavých 35 dnů, proto monitoring spouštěj aspoň 1x měsíčně.",
            ],
        },
    },
    "rdap": {
        "pripony_predpony": ["e", "moje", "muj", "web", "online", "shop",
                             "eshop", "info", "cz", "sk", "24"],
        "max_kandidatu_na_slovo": 200,
        "prodleva_sekund": 1.2,
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


def _nrd_feed(config: dict, tlds, offline):
    nrd = config.get("zdroje", {}).get("nrd", {})
    return zdroje.NrdFeed(
        tlds=tlds,
        zaklad=nrd.get("zaklad", zdroje.NRD_ZAKLAD),
        okna=nrd.get("okna", zdroje.NRD_OKNA),
        offline_soubory=offline,
    )


def zdroje_pro_tld(config: dict, tld: str, volby, sdileny_nrd=None):
    """Sestaví seznam zdrojů pro dané TLD podle konfigurace.

    Zdroje se sčítají - výsledné množiny domén se sjednotí. NrdFeed se
    předává sdílený, aby se velké soubory stahovaly jen jednou pro obě TLD.
    """
    nastaveni = config.get("zdroje", {}).get(tld, {})
    seznam = []

    if tld == "sk":
        if nastaveni.get("seznam", True):
            seznam.append(zdroje.SkNic(
                url=nastaveni.get("url", "https://sk-nic.sk/subory/domains.txt"),
                kodovani=nastaveni.get("kodovani", "iso-8859-2"),
                offline_soubor=volby.offline_sk,
            ))
    else:
        if nastaveni.get("urls"):
            seznam.append(zdroje.CzNicOpenData(
                urls=nastaveni.get("urls", []),
                kodovani=nastaveni.get("kodovani", "utf-8"),
                offline_soubor=volby.offline_cz,
            ))
        elif volby.offline_cz:
            seznam.append(zdroje.CzNicOpenData(
                urls=[], kodovani=nastaveni.get("kodovani", "utf-8"),
                offline_soubor=volby.offline_cz,
            ))
        if nastaveni.get("rdap", True) and not volby.offline_cz:
            rdap = config.get("rdap", {})
            seznam.append(zdroje.CzRdap(
                konfigurace_slov=config.get("klicova_slova", []),
                pripony_predpony=rdap.get("pripony_predpony", []),
                max_na_slovo=int(rdap.get("max_kandidatu_na_slovo", 200)),
                prodleva=float(rdap.get("prodleva_sekund", 1.2)),
            ))

    if nastaveni.get("nrd", True) and sdileny_nrd is not None:
        seznam.append(_NrdProTld(sdileny_nrd, tld))
    return seznam


class _NrdProTld:
    """Obal, který ze sdíleného feedu vydá výsledek pro jedno TLD."""

    def __init__(self, feed, tld):
        self.feed = feed
        self.tld = tld

    def stahni(self):
        return self.feed.vysledek_pro(self.tld)


def _varuj_pri_dlouhe_mezere(sklad, obdobi: str, tld: str):
    """Feed nových domén sahá 35 dnů zpět; delší pauza znamená ztrátu dat."""
    posledni = sklad.posledni_beh_pred(obdobi, tld)
    if not posledni:
        return
    try:
        kdy = datetime.datetime.fromisoformat(posledni)
    except ValueError:
        return
    dnu = (datetime.datetime.now() - kdy).days
    if dnu > zdroje.NRD_POKRYTI_DNU:
        log.warning(
            "Od posledního běhu pro .%s uplynulo %d dnů, ale feed nových "
            "domén sahá jen %d dnů zpět – registrace ze starší části mezery "
            "už v něm nejsou. Spouštěj monitoring alespoň jednou měsíčně.",
            tld, dnu, zdroje.NRD_POKRYTI_DNU)


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
    offline = bool(volby.offline_cz or volby.offline_sk)
    sdileny_nrd = _nrd_feed(config, tuple(tlds), volby.offline_nrd) \
        if (volby.offline_nrd or not offline) else None

    for tld in tlds:
        if sklad.beh_existuje(volby.obdobi, tld) and not volby.znovu:
            log.info("Pro .%s už běh za %s proběhl - přeskakuji "
                     "(vynutit lze volbou --znovu).", tld, volby.obdobi)
            continue

        _varuj_pri_dlouhe_mezere(sklad, volby.obdobi, tld)

        vsechny = set()
        registratori = {}
        zdroje_domen = {}
        popisy = []
        uplny_zdroj = False

        for zdroj in zdroje_pro_tld(config, tld, volby, sdileny_nrd):
            try:
                vysledek = zdroj.stahni()
            except zdroje.ChybaZdroje as chyba:
                log.error(".%s – zdroj selhal: %s", tld, chyba)
                continue
            log.info(".%s – %s: %d domén", tld, vysledek.nazev or "zdroj",
                     len(vysledek.domeny))
            vsechny |= vysledek.domeny
            registratori.update(vysledek.registratori)
            for domena in vysledek.domeny:
                zdroje_domen.setdefault(domena, vysledek.nazev or "zdroj")
            popisy.append(vysledek.popis)
            if vysledek.uplny_seznam:
                uplny_zdroj = True

        if not popisy:
            log.error(".%s: nepodařilo se získat data ze žádného zdroje.", tld)
            selhani += 1
            continue

        # "Nová doména" = dosud neviděná. Nezávisí to na délce mezery mezi
        # běhy ani na tom, kolik zdrojů ji nahlásilo.
        nove = sklad.rozdel_na_nove(vsechny, tld)

        # Při prvním běhu s úplným seznamem jsou "nové" všechny domény
        # registru. Report je i tak užitečný - je to vstupní audit toho, co
        # kolem značky existuje už teď - jen se označí jako výchozí stav,
        # aby bylo jasné, že nejde o nové registrace.
        vychozi_stav = uplny_zdroj and not sklad.zna_tld(tld)
        log.info(".%s: %d domén ze zdrojů, %d dosud neviděných%s.",
                 tld, len(vsechny), len(nove),
                 " (první běh – výchozí stav)" if vychozi_stav else "")

        nalezy = shoda.najdi_shody(
            nove, config.get("klicova_slova", []),
            config.get("ignorovat_domeny", []),
            config.get("stoplist", []),
        )
        vysoka = sum(1 for n in nalezy if n.jistota == "vysoká")
        log.info(".%s: %d nálezů (%d vysoká shoda, %d možné překlepy).",
                 tld, len(nalezy), vysoka, len(nalezy) - vysoka)

        snapshot = sklad.uloz_snapshot(volby.obdobi, tld, vsechny)
        sklad.uloz_beh(
            obdobi=volby.obdobi, tld=tld,
            spusteno=datetime.datetime.now().isoformat(timespec="seconds"),
            zdroj=" + ".join(popisy), pocet_domen=len(vsechny),
            pocet_novych=len(nove), vychozi_stav=vychozi_stav,
            snapshot_soubor=snapshot,
        )
        sklad.uloz_nalezy(volby.obdobi, tld, nalezy, registratori, zdroje_domen)
        sklad.zaznamenej_videne(vsechny, tld, volby.obdobi,
                                "+".join(sorted(set(zdroje_domen.values()))))
        zpracovano = True

    sklad.uklid_snapshotu(int(config.get("uchovavat_snapshotu", 6)))

    slozka_reportu = os.path.join(KOREN, "reporty")
    behy = sklad.behy_obdobi(volby.obdobi)
    if not behy:
        log.error("Žádný zdroj se nepodařilo zpracovat, report nevznikl.")
        return selhani or 1
    cesta = report.generuj_report(
        volby.obdobi, behy,
        sklad.nalezy_obdobi(volby.obdobi, jistota="vysoká"),
        sklad.nalezy_obdobi(volby.obdobi, jistota="možný překlep"),
        slozka_reportu)
    report.generuj_index(sklad.vsechna_obdobi(), sklad.pocty_nalezu(),
                         slozka_reportu)
    print("\nHotovo. Report: %s" % cesta)

    if (zpracovano and config.get("otevrit_report", True) and not volby.tichy
            and hasattr(os, "startfile")):
        os.startfile(cesta)  # jen Windows: otevře report v prohlížeči
    return selhani


def over_zdroje(config: dict, volby) -> int:
    """Zkusí každý nastavený zdroj a vypíše výsledek - nic neukládá."""
    chyby = 0
    print("Ověřuji datové zdroje...\n")

    # Feed nových domén (společný pro .cz i .sk)
    try:
        feed = _nrd_feed(config, ("cz", "sk"), volby.offline_nrd)
        feed._nacti()
        print("[OK]     feed nových domén – %d× .cz, %d× .sk za posledních %d dnů"
              % (len(feed._mezipamet.get("cz", ())),
                 len(feed._mezipamet.get("sk", ())), zdroje.NRD_POKRYTI_DNU))
    except zdroje.ChybaZdroje as chyba:
        chyby += 1
        print("[CHYBA]  feed nových domén – %s" % chyba)

    # Úplný seznam .sk
    if config.get("zdroje", {}).get("sk", {}).get("seznam", True):
        try:
            vysledek = zdroje.SkNic(
                url=config.get("zdroje", {}).get("sk", {}).get(
                    "url", "https://sk-nic.sk/subory/domains.txt"),
                offline_soubor=volby.offline_sk).stahni()
            print("[OK]     .sk seznam SK-NIC – %d domén" % len(vysledek.domeny))
        except zdroje.ChybaZdroje as chyba:
            chyby += 1
            print("[CHYBA]  .sk seznam SK-NIC – %s" % chyba)

    # RDAP .cz
    if config.get("zdroje", {}).get("cz", {}).get("rdap", True):
        if zdroje.CzRdap([], [])._rdap_registrovana("nic.cz"):
            print("[OK]     .cz RDAP rdap.nic.cz odpovídá")
        else:
            chyby += 1
            print("[CHYBA]  .cz RDAP rdap.nic.cz neodpovídá")

    # Volitelný seznam .cz z otevřených dat
    if config.get("zdroje", {}).get("cz", {}).get("urls"):
        try:
            vysledek = zdroje.CzNicOpenData(
                urls=config["zdroje"]["cz"]["urls"]).stahni()
            print("[OK]     .cz seznam – %d domén" % len(vysledek.domeny))
        except zdroje.ChybaZdroje as chyba:
            chyby += 1
            print("[CHYBA]  .cz seznam – %s" % chyba)

    print("\n%s" % ("Vše připraveno, spusť běh: %s" % _jak_spustit()
                    if not chyby else
                    "Některý zdroj nefunguje – ostatní zdroje ale fungují dál, "
                    "monitoring poběží i tak. Podrobnosti v README."))
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
    parser.add_argument("--offline-nrd", metavar="SOUBOR", action="append",
                        help="místo stahování použít lokální soubor feedu "
                             "nových domén (lze uvést vícekrát)")
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
