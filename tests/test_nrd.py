"""Testy feedu nově registrovaných domén a ukotvení překlepové shody."""

import os
import unittest

from monitor import shoda, zdroje

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")
VZOREK = os.path.join(FIXTURES, "nrd_vzorek.txt")


class TestNrdFeed(unittest.TestCase):
    def _feed(self, tlds=("cz",)):
        return zdroje.NrdFeed(tlds=tlds, offline_soubory=[VZOREK])

    def test_filtruje_na_tld(self):
        vysledek = self._feed().stahni()
        self.assertEqual(vysledek.tld, "cz")
        self.assertIn("novaskoda.cz", vysledek.domeny)
        self.assertIn("raifeisenbank.cz", vysledek.domeny)
        self.assertNotIn("example.org", vysledek.domeny)
        self.assertNotIn("skodabratislava.sk", vysledek.domeny)

    def test_preskoci_komentare(self):
        vysledek = self._feed().stahni()
        self.assertFalse(any(d.startswith("#") for d in vysledek.domeny))
        self.assertFalse(any("title" in d for d in vysledek.domeny))

    def test_subdomena_se_zkrati_na_druhy_rad(self):
        vysledek = self._feed().stahni()
        self.assertIn("podivny-zaznam.cz", vysledek.domeny)
        self.assertNotIn("www.podivny-zaznam.cz", vysledek.domeny)

    def test_jeden_feed_obslouzi_vic_tld(self):
        feed = self._feed(("cz", "sk"))
        cz = feed.vysledek_pro("cz")
        sk = feed.vysledek_pro("sk")
        self.assertIn("novaskoda.cz", cz.domeny)
        self.assertIn("skodabratislava.sk", sk.domeny)
        self.assertNotIn("skodabratislava.sk", cz.domeny)

    def test_neni_uplny_seznam(self):
        # Feed je výřez, ne celý registr - report ho hlásí hned.
        self.assertFalse(self._feed().stahni().uplny_seznam)

    def test_prazdny_vstup_neshodi_beh(self):
        prazdny = os.path.join(FIXTURES, "cz_domains.txt")
        feed = zdroje.NrdFeed(tlds=("sk",), offline_soubory=[prazdny])
        self.assertEqual(feed.stahni().domeny, set())


class TestUkotveniPreklepu(unittest.TestCase):
    """Regrese: čeština je plná slov ve vzdálenosti 1 od běžných značek.

    Bez ukotvení na hranici tokenu dělalo fuzzy porovnání na reálných
    datech 28 nálezů pro „skoda“, z toho drtivou většinu nesmyslných.
    """

    FALESNE = [
        "autoskola-schejbal.cz",    # autoškola
        "mikulaskova.cz",           # příjmení -ková
        "evahruskova.cz",
        "chorvatskoapartmany.cz",   # Chorvatsko
        "vecerniskola.cz",          # škola
        "kryptoskola.cz",
    ]
    SKUTECNE = [
        ("raifeisenbank.cz", "raiffeisen"),
        ("eznam.cz", "seznam"),
    ]

    def test_falesne_poplachy_neprojdou(self):
        for domena in self.FALESNE:
            nalezy = shoda.najdi_shody_domeny(domena, [("skoda", True)])
            self.assertEqual(nalezy, [], "%s nemá být nález" % domena)

    def test_skutecne_preklepy_projdou(self):
        for domena, slovo in self.SKUTECNE:
            nalezy = shoda.najdi_shody_domeny(domena, [(slovo, True)])
            self.assertTrue(nalezy, "%s má být nález pro %s" % (domena, slovo))
            self.assertEqual(nalezy[0].jistota, "možný překlep")

    def test_presna_shoda_ma_vysokou_jistotu(self):
        nalezy = shoda.najdi_shody_domeny("skodadoplnky.cz", [("skoda", True)])
        self.assertEqual(nalezy[0].jistota, "vysoká")
        self.assertEqual(nalezy[0].typ, "přesná shoda")

    def test_znacka_za_pomlckou_projde(self):
        # Ukotvení nesmí zabít legitimní případ „moje-skoda“ s překlepem.
        nalezy = shoda.najdi_shody_domeny("moje-skodaa.cz", [("skoda", True)])
        self.assertTrue(nalezy)

    def test_stoplist_potlaci_nalez(self):
        # „skola“ je ve výchozím stoplistu, i když je na začátku názvu.
        self.assertEqual(
            shoda.najdi_shody_domeny("skola-online.cz", [("skoda", True)]), [])

    def test_vlastni_stoplist_z_configu(self):
        nalezy = shoda.najdi_shody({"skodik.cz"}, [{"slovo": "skoda"}],
                                   stoplist=["skodik"])
        self.assertEqual(nalezy, [])

    def test_hranice_tokenu(self):
        self.assertEqual(shoda.hranice_tokenu("moje-skoda-dily"), [0, 5, 11])


if __name__ == "__main__":
    unittest.main()
