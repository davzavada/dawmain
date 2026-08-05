"""End-to-end testy: běhy nad lokálními soubory (bez sítě) a správa slov."""

import json
import os
import shutil
import tempfile
import unittest

from monitor import __main__ as hlavni

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")

CZ_CERVENEC = "kadernictvi-praha.cz\nautoskoda-plzen.cz\nobchod-online.cz\n"
CZ_SRPEN = CZ_CERVENEC + "novaskoda.cz\npekarna-nova.cz\n"


class ZakladTestu(unittest.TestCase):
    def setUp(self):
        self.puvodni_koren = hlavni.KOREN
        self.tmp = tempfile.mkdtemp(prefix="monitor-test-")
        hlavni.KOREN = self.tmp

    def tearDown(self):
        hlavni.KOREN = self.puvodni_koren
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _soubor(self, nazev, obsah):
        cesta = os.path.join(self.tmp, nazev)
        with open(cesta, "w", encoding="utf-8") as f:
            f.write(obsah)
        return cesta

    def _config(self, **zmeny):
        config = {
            "klicova_slova": [{"slovo": "skoda", "preklepy": True}],
            "ignorovat_domeny": [],
            "zdroje": {"sk": {"url": ""}, "cz": {"urls": []}},
            "otevrit_report": False,
        }
        config.update(zmeny)
        with open(os.path.join(self.tmp, "config.json"), "w", encoding="utf-8") as f:
            json.dump(config, f)


class TestDvouObdobniBeh(ZakladTestu):
    def setUp(self):
        super().setUp()
        self._config()
        self.cz07 = self._soubor("cz07.txt", CZ_CERVENEC)
        self.cz08 = self._soubor("cz08.txt", CZ_SRPEN)
        self.sk = os.path.join(FIXTURES, "sk_domains.txt")

    def _report(self, obdobi):
        cesta = os.path.join(self.tmp, "reporty", "%s.html" % obdobi)
        self.assertTrue(os.path.exists(cesta), "chybí report %s" % cesta)
        with open(cesta, encoding="utf-8") as f:
            return f.read()

    def _spust(self, obdobi, cz):
        return hlavni.main([
            "spustit", "--obdobi", obdobi, "--tichy",
            "--offline-cz", cz, "--offline-sk", self.sk,
        ])

    def test_cely_prubeh(self):
        # 1. běh = výchozí stav: hlásí existující shody
        self.assertEqual(self._spust("2026-07", self.cz07), 0)
        html07 = self._report("2026-07")
        self.assertIn("výchozí stav", html07)
        self.assertIn("autoskoda-plzen.cz", html07)
        self.assertIn("skodaservis.sk", html07)      # z fixture SK-NIC
        self.assertIn("NOVA-0001", html07)           # registrátor ze SK souboru

        # 2. běh hlásí jen nově registrované domény
        self.assertEqual(self._spust("2026-08", self.cz08), 0)
        html08 = self._report("2026-08")
        self.assertIn("novaskoda.cz", html08)
        self.assertNotIn("autoskoda-plzen.cz", html08)
        self.assertNotIn("výchozí stav", html08)

        # opakované spuštění stejného období nic nerozbije (idempotence)
        self.assertEqual(self._spust("2026-08", self.cz08), 0)
        self.assertIn("novaskoda.cz", self._report("2026-08"))

        # přehledová stránka zná obě období
        with open(os.path.join(self.tmp, "reporty", "index.html"),
                  encoding="utf-8") as f:
            index = f.read()
        self.assertIn("2026-07", index)
        self.assertIn("2026-08", index)

    def test_tydenni_znacky(self):
        self.assertEqual(self._spust("2026-W31", self.cz07), 0)
        self.assertEqual(self._spust("2026-W32", self.cz08), 0)
        html = self._report("2026-W32")
        self.assertIn("novaskoda.cz", html)
        self.assertNotIn("výchozí stav", html)

    def test_spatne_obdobi(self):
        with self.assertRaises(SystemExit):
            hlavni.main(["spustit", "--obdobi", "srpen"])

    def test_bez_klicovych_slov(self):
        self._config(klicova_slova=[])
        self.assertEqual(self._spust("2026-07", self.cz07), 1)


class TestSpravaSlov(ZakladTestu):
    def _slova(self):
        with open(os.path.join(self.tmp, "config.json"), encoding="utf-8") as f:
            return json.load(f)["klicova_slova"]

    def test_pridani_vypis_odebrani(self):
        # config.json neexistuje -> vytvoří se automaticky
        self.assertEqual(hlavni.main(["pridej-slovo", "Škoda"]), 0)
        self.assertEqual(self._slova(), [{"slovo": "škoda", "preklepy": True}])

        # duplicitní přidání (i bez diakritiky) se nepřidá podruhé
        self.assertEqual(hlavni.main(["pridej-slovo", "skoda"]), 0)
        self.assertEqual(len(self._slova()), 1)

        self.assertEqual(hlavni.main(["pridej-slovo", "cez", "--bez-preklepu"]), 0)
        self.assertEqual(self._slova()[1], {"slovo": "cez", "preklepy": False})

        self.assertEqual(hlavni.main(["slova"]), 0)

        self.assertEqual(hlavni.main(["odeber-slovo", "škoda"]), 0)
        self.assertEqual(len(self._slova()), 1)
        self.assertEqual(hlavni.main(["odeber-slovo", "neexistuje"]), 1)

    def test_pridani_bez_hodnoty(self):
        self.assertEqual(hlavni.main(["pridej-slovo"]), 1)


if __name__ == "__main__":
    unittest.main()
