"""Generování měsíčních HTML reportů (čistá stdlib, inline CSS, česky)."""

import html
import logging
import os

from . import shoda

log = logging.getLogger("monitor")

_STYL = """
body { font-family: "Segoe UI", system-ui, sans-serif; margin: 2rem auto;
       max-width: 68rem; padding: 0 1rem; color: #1a2733; background: #fff; }
h1 { font-size: 1.5rem; border-bottom: 3px solid #0b6ea8; padding-bottom: .4rem; }
h2 { font-size: 1.15rem; margin-top: 2rem; color: #0b6ea8; }
table { border-collapse: collapse; width: 100%; margin-top: .5rem; }
th, td { text-align: left; padding: .45rem .6rem; border-bottom: 1px solid #dbe4ec; }
th { background: #eef4f9; font-weight: 600; }
tr:hover td { background: #f6fafd; }
a { color: #0b6ea8; }
.souhrn { display: flex; gap: 1rem; flex-wrap: wrap; margin: 1rem 0; }
.karta { border: 1px solid #dbe4ec; border-radius: .5rem; padding: .8rem 1.1rem;
         background: #f8fbfd; min-width: 14rem; }
.karta b { font-size: 1.3rem; display: block; }
.stitek { display: inline-block; padding: .1rem .5rem; border-radius: 1rem;
          font-size: .8rem; background: #e3edf5; white-space: nowrap; }
.stitek.presna { background: #fde3e3; }
.upozorneni { background: #fff7e0; border: 1px solid #e8d48a; border-radius: .5rem;
              padding: .7rem 1rem; margin: 1rem 0; }
.pata { margin-top: 3rem; color: #64748b; font-size: .85rem;
        border-top: 1px solid #dbe4ec; padding-top: .8rem; }
.nic { color: #64748b; font-style: italic; }
"""


def _stranka(titulek: str, telo: str) -> str:
    return (
        "<!DOCTYPE html>\n<html lang=\"cs\">\n<head>\n<meta charset=\"utf-8\">\n"
        "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n"
        "<title>%s</title>\n<style>%s</style>\n</head>\n<body>\n%s\n</body>\n</html>\n"
        % (html.escape(titulek), _STYL, telo)
    )


def _odkaz_registru(domena: str, tld: str) -> str:
    if tld == "cz":
        return ('<a href="https://rdap.nic.cz/domain/%s" target="_blank" '
                'rel="noopener">RDAP</a>' % html.escape(domena))
    return ('<a href="https://whois.sk-nic.sk/" target="_blank" '
            'rel="noopener">WHOIS</a>')


def _stitek_typu(typ: str) -> str:
    trida = "stitek presna" if typ.startswith("přesná") else "stitek"
    return '<span class="%s">%s</span>' % (trida, html.escape(typ))


def generuj_report(obdobi, behy, nalezy, slozka_reportu) -> str:
    """Vytvoří reporty/<značka období>.html a vrátí cestu k němu.

    behy:   řádky (tld, spusteno, zdroj, pocet_domen, pocet_novych, vychozi_stav)
    nalezy: řádky (slovo, domena, tld, typ, registrator) seřazené podle slova
    """
    os.makedirs(slozka_reportu, exist_ok=True)
    casti = ["<h1>Monitoring domén – report za %s</h1>" % html.escape(obdobi)]

    casti.append('<div class="souhrn">')
    vychozi = False
    for tld, spusteno, zdroj, pocet_domen, pocet_novych, vychozi_stav in behy:
        vychozi = vychozi or bool(vychozi_stav)
        popisek = "výchozí stav" if vychozi_stav else "nových za období"
        casti.append(
            '<div class="karta"><b>.%s</b>%s prohledaných domén,<br>'
            "%s %s<br><small>zdroj: %s<br>staženo %s</small></div>"
            % (html.escape(tld), "{:,}".format(pocet_domen).replace(",", "&nbsp;"),
               "{:,}".format(pocet_novych).replace(",", "&nbsp;"),
               popisek, html.escape(zdroj), html.escape(spusteno[:16].replace("T", " ")))
        )
    casti.append("</div>")

    if vychozi:
        casti.append(
            '<div class="upozorneni">První běh pro některé TLD: report ukazuje '
            "<b>výchozí stav</b> – všechny už existující domény odpovídající "
            "klíčovým slovům. Od příštího běhu se budou hlásit jen nově "
            "registrované.</div>"
        )

    if not nalezy:
        casti.append('<p class="nic">Žádná nová doména neodpovídá klíčovým slovům.</p>')

    podle_slova = {}
    for slovo, domena, tld, typ, registrator in nalezy:
        podle_slova.setdefault(slovo, []).append((domena, tld, typ, registrator))

    for slovo in sorted(podle_slova):
        radky = podle_slova[slovo]
        casti.append("<h2>„%s“ – %d nález%s</h2>"
                     % (html.escape(slovo), len(radky),
                        "" if len(radky) == 1 else ("y" if len(radky) < 5 else "ů")))
        casti.append("<table><tr><th>Doména</th><th>Typ shody</th>"
                     "<th>Registrátor</th><th>Odkazy</th></tr>")
        for domena, tld, typ, registrator in radky:
            zobrazeni = html.escape(domena)
            if "xn--" in domena:
                dekodovana = shoda.dekoduj_idn(domena)
                if dekodovana != domena:
                    zobrazeni += " <small>(zobrazí se jako %s)</small>" % html.escape(dekodovana)
            casti.append(
                "<tr><td>%s</td><td>%s</td><td>%s</td>"
                '<td><a href="http://%s" target="_blank" rel="noopener">web</a> '
                "· %s</td></tr>"
                % (zobrazeni, _stitek_typu(typ),
                   html.escape(registrator or "–"), html.escape(domena),
                   _odkaz_registru(domena, tld))
            )
        casti.append("</table>")

    casti.append('<p class="pata">Vygenerováno aplikací Monitoring domén. '
                 'Zdroje dat: oficiální seznamy registrů CZ.NIC a SK-NIC. '
                 '<a href="index.html">Přehled všech reportů</a></p>')

    cesta = os.path.join(slozka_reportu, "%s.html" % obdobi)
    with open(cesta, "w", encoding="utf-8") as f:
        f.write(_stranka("Monitoring domén %s" % obdobi, "\n".join(casti)))
    log.info("Report uložen: %s", cesta)
    return cesta


def generuj_index(obdobi_seznam, pocty_nalezu, slozka_reportu) -> str:
    """Přehledová stránka se seznamem všech reportů."""
    os.makedirs(slozka_reportu, exist_ok=True)
    casti = ["<h1>Monitoring domén – přehled reportů</h1>"]
    if not obdobi_seznam:
        casti.append('<p class="nic">Zatím neproběhl žádný běh.</p>')
    else:
        casti.append("<table><tr><th>Období</th><th>Nálezů</th><th>Report</th></tr>")
        for obdobi in obdobi_seznam:
            casti.append(
                "<tr><td>%s</td><td>%d</td>"
                '<td><a href="%s.html">otevřít</a></td></tr>'
                % (html.escape(obdobi), pocty_nalezu.get(obdobi, 0), html.escape(obdobi))
            )
        casti.append("</table>")
    cesta = os.path.join(slozka_reportu, "index.html")
    with open(cesta, "w", encoding="utf-8") as f:
        f.write(_stranka("Monitoring domén – přehled", "\n".join(casti)))
    return cesta
