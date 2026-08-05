import os
import unittest

from monitor import zdroje

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")


class TestParser(unittest.TestCase):
    def test_sk_format_bez_koncovky(self):
        with open(os.path.join(FIXTURES, "sk_domains.txt"), "rb") as f:
            text = f.read().decode("iso-8859-2")
        domeny, registratori = zdroje.rozeber_seznam(text, "sk")
        self.assertIn("skodaservis.sk", domeny)
        self.assertIn("sk0da-eshop.sk", domeny)
        self.assertEqual(len(domeny), 6)
        # hlavička tabulky nesmí vyrobit falešnou doménu
        self.assertNotIn("domena.sk", domeny)
        self.assertEqual(registratori["skodaservis.sk"], "NOVA-0001")

    def test_cz_prosty_seznam(self):
        with open(os.path.join(FIXTURES, "cz_domains.txt"), encoding="utf-8") as f:
            domeny, _ = zdroje.rozeber_seznam(f.read(), "cz")
        self.assertEqual(len(domeny), 7)
        self.assertIn("xn--koda-f6a.cz", domeny)

    def test_cz_csv_s_id_v_prvnim_sloupci(self):
        with open(os.path.join(FIXTURES, "cz_domains.csv"), encoding="utf-8") as f:
            domeny, registratori = zdroje.rozeber_seznam(f.read(), "cz")
        self.assertEqual(domeny, {"novaskoda.cz", "eshop-praha.cz", "skooda.cz"})
        # ID 1001 se nesmí zaměnit za doménu, registrátor je sloupec za doménou
        self.assertNotIn("1001.cz", domeny)
        self.assertEqual(registratori["novaskoda.cz"], "REG-MOJEID")

    def test_treti_rad_se_ignoruje(self):
        domeny, _ = zdroje.rozeber_seznam("www.priklad.cz\npriklad.cz\n", "cz")
        self.assertEqual(domeny, {"priklad.cz"})

    def test_detekce_html(self):
        with self.assertRaises(zdroje.ChybaZdroje):
            zdroje._zkontroluj_ze_neni_html("<!DOCTYPE html><html>...", "http://x")


class TestOfflineZdroje(unittest.TestCase):
    def test_sknic_offline(self):
        zdroj = zdroje.SkNic(url="", offline_soubor=os.path.join(FIXTURES, "sk_domains.txt"))
        vysledek = zdroj.stahni()
        self.assertEqual(vysledek.tld, "sk")
        self.assertEqual(len(vysledek.domeny), 6)

    def test_cznic_offline(self):
        zdroj = zdroje.CzNicOpenData(
            urls=[], offline_soubor=os.path.join(FIXTURES, "cz_domains.txt"))
        vysledek = zdroj.stahni()
        self.assertEqual(vysledek.tld, "cz")
        self.assertEqual(len(vysledek.domeny), 7)

    def test_cznic_bez_url_srozumitelna_chyba(self):
        with self.assertRaises(zdroje.ChybaZdroje) as kontext:
            zdroje.CzNicOpenData(urls=[]).stahni()
        self.assertIn("config.json", str(kontext.exception))


class TestKandidati(unittest.TestCase):
    def test_generovani(self):
        kandidati = zdroje.generuj_kandidaty("skoda", ["eshop", "24"], limit=200)
        self.assertIn("skoda", kandidati)
        self.assertIn("eshop-skoda", kandidati)
        self.assertIn("skoda24", kandidati)
        self.assertIn("sk0da", kandidati)      # záměna znaků
        self.assertIn("skda", kandidati)       # vynechání
        self.assertIn("skooda", kandidati)     # zdvojení
        self.assertIn("ksoda", kandidati)      # prohození
        # žádné duplicity a všechno platné labely
        self.assertEqual(len(kandidati), len(set(kandidati)))

    def test_limit(self):
        kandidati = zdroje.generuj_kandidaty("skoda", ["a", "b", "c"], limit=10)
        self.assertLessEqual(len(kandidati), 10)


if __name__ == "__main__":
    unittest.main()
