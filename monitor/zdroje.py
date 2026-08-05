"""Adaptéry datových zdrojů registrů domén.

Každý zdroj vrací ZdrojVysledek s množinou registrovaných domén daného
TLD. Parser je záměrně obranný: formáty souborů registrů se mohou měnit,
proto si sám odhadne oddělovač i sloupec s doménou a při nezdaru vypíše
srozumitelnou chybu s ukázkou řádku.
"""

from dataclasses import dataclass, field
import gzip
import io
import json
import logging
import re
import socket
import time
import urllib.error
import urllib.request

from . import shoda

log = logging.getLogger("monitor")

UZIVATELSKY_AGENT = "MonitoringDomen/0.1 (lokalni mesicni monitoring; python-stdlib)"
_VZOR_LABELU = re.compile(r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$")


class ChybaZdroje(Exception):
    """Zdroj se nepodařilo stáhnout nebo mu porozumět."""


@dataclass
class ZdrojVysledek:
    tld: str
    domeny: set = field(default_factory=set)
    registratori: dict = field(default_factory=dict)
    popis: str = ""


def _platna_domena(nazev: str, tld: str) -> bool:
    if not nazev.endswith("." + tld):
        return False
    label = nazev[: -(len(tld) + 1)]
    return bool(_VZOR_LABELU.match(label))


# Řádek v úvodu souboru obsahující některé z těchto slov jako celou hodnotu
# se považuje za hlavičku tabulky a přeskočí se celý.
_HLAVICKOVA_SLOVA = {"id", "domena", "doména", "domain", "nazov", "názov",
                     "nazev", "název", "meno", "name"}


def rozeber_seznam(text: str, tld: str):
    """Obranný parser seznamu domén (prostý seznam, CSV se ; , nebo tab).

    Vrací (množina domén, {doména: následující sloupec}) - následující
    sloupec se u SK-NIC využívá jako registrátor. Komentáře (#, --) se
    přeskakují; hlavičková slova se ignorují v prvních řádcích souboru.
    V každém řádku se přednostně bere sloupec, který už koncovku TLD
    obsahuje; teprve potom první sloupec vypadající jako label (tomu se
    koncovka doplní).
    """
    domeny = set()
    doplnek = {}
    for cislo, radek in enumerate(text.splitlines()):
        radek = radek.strip()
        if not radek or radek.startswith("#") or radek.startswith("--"):
            continue
        for oddelovac in (";", ",", "\t"):
            if oddelovac in radek:
                pole = radek.split(oddelovac)
                break
        else:
            pole = radek.split()
        puvodni = [p.strip().strip('"') for p in pole]
        hodnoty = [p.lower().rstrip(".") for p in puvodni]
        if cislo < 5 and any(h in _HLAVICKOVA_SLOVA for h in hodnoty):
            continue

        domena = None
        pozice = None
        for i, hodnota in enumerate(hodnoty):          # 1. průchod: plný název
            if hodnota and "." in hodnota and _platna_domena(hodnota, tld):
                domena, pozice = hodnota, i
                break
        if domena is None:
            for i, hodnota in enumerate(hodnoty):      # 2. průchod: samotný label
                if not hodnota or "." in hodnota:
                    continue
                if _platna_domena(hodnota + "." + tld, tld):
                    domena, pozice = hodnota + "." + tld, i
                    break
        if domena:
            domeny.add(domena)
            zbytek = [h for h in puvodni[pozice + 1:] if h]
            if zbytek:
                doplnek[domena] = zbytek[0]
    return domeny, doplnek


def _stahni_url(url: str, kodovani: str, pokusy: int = 3) -> str:
    """Stáhne URL s opakováním a exponenciálním čekáním, vrátí text."""
    pozadavek = urllib.request.Request(url, headers={
        "User-Agent": UZIVATELSKY_AGENT,
        "Accept-Encoding": "gzip",
    })
    posledni_chyba = None
    for pokus in range(pokusy):
        if pokus:
            cekani = 2 ** pokus
            log.info("Opakuji stažení za %d s ...", cekani)
            time.sleep(cekani)
        try:
            with urllib.request.urlopen(pozadavek, timeout=120) as odpoved:
                data = odpoved.read()
                if odpoved.headers.get("Content-Encoding") == "gzip" or url.endswith(".gz"):
                    data = gzip.decompress(data)
                return data.decode(kodovani, errors="replace")
        except (urllib.error.URLError, OSError) as chyba:
            posledni_chyba = chyba
            log.warning("Stažení %s selhalo: %s", url, chyba)
    raise ChybaZdroje("Nepodařilo se stáhnout %s (%s)" % (url, posledni_chyba))


def _zkontroluj_ze_neni_html(text: str, url: str):
    zacatek = text.lstrip()[:200].lower()
    if zacatek.startswith("<!doctype") or zacatek.startswith("<html"):
        raise ChybaZdroje(
            "URL %s vrací webovou stránku (HTML), ne datový soubor. "
            "Otevři ji v prohlížeči a najdi na ní přímý odkaz na soubor "
            "se seznamem domén; ten pak vlož do config.json." % url
        )


class SkNic:
    """Oficiální denní seznam všech .sk domén od SK-NIC."""

    def __init__(self, url: str, kodovani: str = "iso-8859-2", offline_soubor=None):
        self.url = url
        self.kodovani = kodovani
        self.offline_soubor = offline_soubor

    def stahni(self) -> ZdrojVysledek:
        if self.offline_soubor:
            with open(self.offline_soubor, "rb") as soubor:
                text = soubor.read().decode(self.kodovani, errors="replace")
            popis = "SK-NIC (lokální soubor %s)" % self.offline_soubor
        else:
            log.info("Stahuji seznam .sk domén: %s", self.url)
            text = _stahni_url(self.url, self.kodovani)
            _zkontroluj_ze_neni_html(text, self.url)
            popis = "SK-NIC domains.txt (oficiální seznam)"
        domeny, registratori = rozeber_seznam(text, "sk")
        if not domeny:
            ukazka = text.splitlines()[:3]
            raise ChybaZdroje(
                "V souboru SK-NIC se nepodařilo najít žádnou doménu. "
                "Formát se možná změnil; první řádky: %r" % ukazka
            )
        return ZdrojVysledek(tld="sk", domeny=domeny,
                             registratori=registratori, popis=popis)


class CzNicOpenData:
    """Hromadný seznam .cz domén z otevřených dat CZ.NIC.

    Přesné URL souboru se doplňuje do config.json (viz README, sekce
    První spuštění) - zkouší se postupně všechny zadané adresy.
    """

    def __init__(self, urls, kodovani: str = "utf-8", offline_soubor=None):
        self.urls = [u for u in urls if u]
        self.kodovani = kodovani
        self.offline_soubor = offline_soubor

    def stahni(self) -> ZdrojVysledek:
        if self.offline_soubor:
            with open(self.offline_soubor, "rb") as soubor:
                surova = soubor.read()
                if self.offline_soubor.endswith(".gz"):
                    surova = gzip.decompress(surova)
                text = surova.decode(self.kodovani, errors="replace")
            return self._rozeber(text, "CZ.NIC (lokální soubor %s)" % self.offline_soubor)
        if not self.urls:
            raise ChybaZdroje(
                "Pro .cz není v config.json vyplněná žádná adresa seznamu domén "
                "(zdroje.cz.urls). Postupuj podle README, sekce 'První spuštění', "
                "nebo nastav zdroje.cz.rezim na 'rdap'."
            )
        posledni = None
        for url in self.urls:
            try:
                log.info("Stahuji seznam .cz domén: %s", url)
                text = _stahni_url(url, self.kodovani)
                _zkontroluj_ze_neni_html(text, url)
                return self._rozeber(text, "CZ.NIC otevřená data (%s)" % url)
            except ChybaZdroje as chyba:
                posledni = chyba
                log.warning("%s", chyba)
        raise ChybaZdroje("Žádná z adres pro .cz nefunguje. Poslední chyba: %s" % posledni)

    def _rozeber(self, text: str, popis: str) -> ZdrojVysledek:
        domeny, registratori = rozeber_seznam(text, "cz")
        if not domeny:
            ukazka = text.splitlines()[:3]
            raise ChybaZdroje(
                "V souboru .cz se nepodařilo najít žádnou doménu. "
                "První řádky: %r" % ukazka
            )
        return ZdrojVysledek(tld="cz", domeny=domeny,
                             registratori=registratori, popis=popis)


# ---------------------------------------------------------------------------
# Záložní zdroj pro .cz: kontrola kandidátních jmen přes oficiální RDAP
# ---------------------------------------------------------------------------

def generuj_kandidaty(slovo: str, pripony_predpony, limit: int):
    """Vytvoří kandidátní labely pro jedno klíčové slovo.

    Kombinuje slovo samotné, předpony/přípony (i s pomlčkou) a
    automaticky generované překlepy (vynechání, zdvojení, prohození
    sousedních znaků, vizuální záměny). Vrací nejvýše `limit` položek.
    """
    slovo = shoda.normalizuj_slovo(slovo)
    kandidati = [slovo]

    for dodatek in pripony_predpony:
        kandidati.append(dodatek + slovo)
        kandidati.append(dodatek + "-" + slovo)
        kandidati.append(slovo + dodatek)
        kandidati.append(slovo + "-" + dodatek)

    preklepove = []
    for i in range(len(slovo)):
        preklepove.append(slovo[:i] + slovo[i + 1:])            # vynechání
        preklepove.append(slovo[:i] + slovo[i] * 2 + slovo[i + 1:])  # zdvojení
    for i in range(len(slovo) - 1):
        preklepove.append(slovo[:i] + slovo[i + 1] + slovo[i] + slovo[i + 2:])  # prohození
    zamena = {"o": "0", "l": "1", "i": "1", "e": "3", "a": "4", "s": "5", "m": "rn", "w": "vv"}
    for i, znak in enumerate(slovo):
        if znak in zamena:
            preklepove.append(slovo[:i] + zamena[znak] + slovo[i + 1:])
    kandidati.extend(preklepove)

    videne = set()
    vysledek = []
    for label in kandidati:
        label = label.strip("-")
        if len(label) < 2 or label in videne or not _VZOR_LABELU.match(label):
            continue
        videne.add(label)
        vysledek.append(label)
        if len(vysledek) >= limit:
            break
    return vysledek


class CzRdapFallback:
    """Záložní zdroj: ověřuje kandidátní .cz jména přes rdap.nic.cz.

    Nejprve levný DNS předfiltr (socket.getaddrinfo), potvrzení jen u
    jmen, která v DNS existují - šetří oficiální RDAP rozhraní. Omezení:
    nezachytí klíčové slovo uvnitř delšího názvu ani registrované, ale
    nedelegované domény; viz navrh.md.
    """

    RDAP_URL = "https://rdap.nic.cz/domain/%s"

    def __init__(self, konfigurace_slov, pripony_predpony, max_na_slovo=200,
                 prodleva=1.0):
        self.konfigurace_slov = konfigurace_slov
        self.pripony_predpony = pripony_predpony
        self.max_na_slovo = max_na_slovo
        self.prodleva = prodleva

    def stahni(self) -> ZdrojVysledek:
        kandidati = set()
        for polozka in self.konfigurace_slov:
            for label in generuj_kandidaty(polozka.get("slovo", ""),
                                           self.pripony_predpony,
                                           self.max_na_slovo):
                kandidati.add(label + ".cz")
        log.info("RDAP fallback: %d kandidátních jmen, spouštím DNS předfiltr",
                 len(kandidati))
        v_dns = {d for d in sorted(kandidati) if self._existuje_v_dns(d)}
        log.info("V DNS nalezeno %d jmen, ověřuji přes rdap.nic.cz "
                 "(prodleva %.1f s mezi dotazy)", len(v_dns), self.prodleva)
        registrovane = set()
        for domena in sorted(v_dns):
            if self._rdap_registrovana(domena):
                registrovane.add(domena)
            time.sleep(self.prodleva)
        return ZdrojVysledek(
            tld="cz", domeny=registrovane,
            popis="RDAP fallback (kontrola %d kandidátních jmen)" % len(kandidati),
        )

    @staticmethod
    def _existuje_v_dns(domena: str) -> bool:
        try:
            socket.getaddrinfo(domena, None)
            return True
        except socket.gaierror:
            return False
        except OSError:
            return False

    def _rdap_registrovana(self, domena: str) -> bool:
        pozadavek = urllib.request.Request(
            self.RDAP_URL % domena,
            headers={"User-Agent": UZIVATELSKY_AGENT, "Accept": "application/rdap+json"},
        )
        try:
            with urllib.request.urlopen(pozadavek, timeout=30) as odpoved:
                json.load(io.TextIOWrapper(odpoved, encoding="utf-8"))
                return True
        except urllib.error.HTTPError as chyba:
            if chyba.code == 404:
                return False
            log.warning("RDAP dotaz na %s vrátil %s", domena, chyba.code)
            return False
        except (urllib.error.URLError, OSError, ValueError) as chyba:
            log.warning("RDAP dotaz na %s selhal: %s", domena, chyba)
            return False
