"""Detekční jádro: porovnávání názvů domén s klíčovými slovy.

Pracuje čistě se standardní knihovnou. Pro každou doménu vyhodnocuje
klíčová slova v tomto pořadí (první zásah vyhrává):

1. přesná shoda        - klíčové slovo je podřetězcem názvu
2. diakritika/IDN      - shoda po převodu punycode (xn--...) a odstranění diakritiky
3. vložená pomlčka     - shoda po odstranění pomlček (s-koda -> skoda)
4. záměna znaků        - shoda po normalizaci vizuálně podobných znaků (sk0da -> skoda)
5. překlep             - Levenshteinova vzdálenost 1-2 v klouzavém okně
"""

from dataclasses import dataclass
import unicodedata

# Vizuálně podobné znaky a "leet speak" záměny. Vícepísmenné záměny se
# aplikují před jednopísmennými (rn vypadá jako m, vv jako w). Mapa se
# aplikuje na obě strany porovnání, takže i/l/1 padají do stejného koše.
_LEET_VICE = [("rn", "m"), ("vv", "w")]
_LEET_JEDEN = str.maketrans({
    "0": "o", "1": "i", "l": "i", "3": "e", "4": "a", "5": "s",
    "6": "b", "7": "t", "8": "b", "9": "g", "2": "z",
})

# Fuzzy porovnání se zapíná až od této délky klíčového slova; kratší slova
# by generovala záplavu falešných poplachů.
MIN_DELKA_PRO_PREKLEPY = 5


@dataclass(frozen=True)
class Nalez:
    """Jeden zásah: doména odpovídá klíčovému slovu daným typem shody."""
    domena: str
    slovo: str
    typ: str


def odstran_diakritiku(text: str) -> str:
    rozlozeny = unicodedata.normalize("NFD", text)
    return "".join(z for z in rozlozeny if not unicodedata.combining(z))


def dekoduj_idn(nazev: str) -> str:
    """Převede punycode zápis (xn--koda-55a) na Unicode (škoda).

    Neplatný punycode vrací beze změny - registry občas obsahují
    xn-- řetězce, které nejsou validním IDN.
    """
    if "xn--" not in nazev:
        return nazev
    try:
        return nazev.encode("ascii").decode("idna")
    except (UnicodeError, UnicodeDecodeError):
        return nazev


def leet_normalizuj(text: str) -> str:
    for vzor, nahrada in _LEET_VICE:
        text = text.replace(vzor, nahrada)
    return text.translate(_LEET_JEDEN)


def _druhy_rad(domena: str) -> str:
    """Vrátí část názvu bez koncovky .cz/.sk (label druhého řádu)."""
    casti = domena.lower().strip().strip(".").split(".")
    if len(casti) >= 2:
        return casti[-2]
    return casti[0]


def levenshtein_do(a: str, b: str, max_vzdalenost: int):
    """Levenshteinova vzdálenost s horní mezí.

    Vrací vzdálenost, pokud je <= max_vzdalenost, jinak None. Řádky, kde
    už minimum přesáhlo mez, výpočet předčasně ukončí.
    """
    if abs(len(a) - len(b)) > max_vzdalenost:
        return None
    predchozi = list(range(len(b) + 1))
    for i, znak_a in enumerate(a, 1):
        radek = [i] + [0] * len(b)
        nejlepsi = i
        for j, znak_b in enumerate(b, 1):
            radek[j] = min(
                predchozi[j] + 1,
                radek[j - 1] + 1,
                predchozi[j - 1] + (znak_a != znak_b),
            )
            nejlepsi = min(nejlepsi, radek[j])
        if nejlepsi > max_vzdalenost:
            return None
        predchozi = radek
    return predchozi[-1] if predchozi[-1] <= max_vzdalenost else None


def max_vzdalenost_pro(slovo: str) -> int:
    """Povolená vzdálenost překlepu podle délky slova (0 = fuzzy vypnuto)."""
    if len(slovo) < MIN_DELKA_PRO_PREKLEPY:
        return 0
    if len(slovo) < 8:
        return 1
    return 2


def preklep_v_textu(slovo: str, text: str, max_vzdalenost: int):
    """Najde v textu klouzavé okno s nejmenší vzdáleností od slova.

    Vrací nejmenší nalezenou vzdálenost 1..max_vzdalenost, jinak None
    (vzdálenost 0 by byla přesná shoda, tu řeší dřívější kroky).
    """
    if max_vzdalenost <= 0:
        return None
    nejlepsi = None
    for delka in range(len(slovo) - max_vzdalenost, len(slovo) + max_vzdalenost + 1):
        if delka <= 0 or delka > len(text):
            continue
        for zacatek in range(len(text) - delka + 1):
            okno = text[zacatek:zacatek + delka]
            vzdalenost = levenshtein_do(slovo, okno, max_vzdalenost)
            if vzdalenost is not None and vzdalenost > 0:
                if nejlepsi is None or vzdalenost < nejlepsi:
                    nejlepsi = vzdalenost
                    if nejlepsi == 1:
                        return 1
    return nejlepsi


def _varianty_nazvu(label: str):
    """Připraví porovnávané varianty názvu se jmenovkou typu shody.

    Pořadí určuje prioritu klasifikace. Vrací navíc normalizovaný tvar
    (pro fuzzy porovnání) a leet-kanonizovaný tvar (pro záměny znaků,
    porovnává se s leet-kanonizovaným klíčovým slovem).
    """
    zaklad = label.lower()
    norm = odstran_diakritiku(dekoduj_idn(zaklad))
    bez_pomlcek = norm.replace("-", "")
    varianty = [(zaklad, "přesná shoda")]
    if norm != zaklad:
        varianty.append((norm, "diakritika/IDN"))
    if bez_pomlcek != norm:
        varianty.append((bez_pomlcek, "vložená pomlčka"))
    return varianty, norm, leet_normalizuj(bez_pomlcek)


def normalizuj_slovo(slovo: str) -> str:
    return odstran_diakritiku(slovo.lower().strip())


def najdi_shody_domeny(domena: str, slova, ignorovat=frozenset()):
    """Vyhodnotí jednu doménu proti všem klíčovým slovům.

    slova: iterable dvojic (normalizované_slovo, preklepy_zapnuty: bool)
    Vrací seznam Nalez (jedna doména může zasáhnout víc slov).
    """
    domena = domena.lower().strip()
    if domena in ignorovat:
        return []
    label = _druhy_rad(domena)
    varianty, norm, leet_label = _varianty_nazvu(label)
    nalezy = []
    for slovo, preklepy in slova:
        if not slovo:
            continue
        zasah = None
        for text, typ in varianty:
            if slovo in text:
                zasah = typ
                break
        if zasah is None and leet_normalizuj(slovo) in leet_label:
            zasah = "záměna znaků"
        if zasah is None and preklepy:
            vzdalenost = preklep_v_textu(slovo, norm, max_vzdalenost_pro(slovo))
            if vzdalenost is not None:
                zasah = "překlep (vzdálenost %d)" % vzdalenost
        if zasah is not None:
            nalezy.append(Nalez(domena=domena, slovo=slovo, typ=zasah))
    return nalezy


def najdi_shody(domeny, konfigurace_slov, ignorovat=()):
    """Projde kolekci domén a vrátí všechny nálezy.

    konfigurace_slov: seznam slovníků {"slovo": ..., "preklepy": bool}
    (formát config.json). Slova se normalizují stejně jako domény, takže
    klíčové slovo smí obsahovat diakritiku.
    """
    slova = []
    for polozka in konfigurace_slov:
        slovo = normalizuj_slovo(polozka.get("slovo", ""))
        if slovo:
            slova.append((slovo, bool(polozka.get("preklepy", True))))
    ignorovat_mnozina = frozenset(d.lower().strip() for d in ignorovat)
    vysledek = []
    for domena in domeny:
        vysledek.extend(najdi_shody_domeny(domena, slova, ignorovat_mnozina))
    return vysledek
