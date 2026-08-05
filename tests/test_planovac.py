import datetime
import unittest

from monitor import planovac


class TestZnackyObdobi(unittest.TestCase):
    DEN = datetime.date(2026, 8, 5)

    def test_znacky(self):
        self.assertEqual(planovac.znacka_obdobi("mesicne", self.DEN), "2026-08")
        self.assertEqual(planovac.znacka_obdobi("tydne", self.DEN), "2026-W32")
        self.assertEqual(planovac.znacka_obdobi("denne", self.DEN), "2026-08-05")

    def test_platnost_znacek(self):
        for znacka in ("2026-08", "2026-W32", "2026-08-05"):
            self.assertTrue(planovac.platna_znacka(znacka), znacka)
        for znacka in ("srpen", "2026", "2026-8", "2026-W3", "26-08-05"):
            self.assertFalse(planovac.platna_znacka(znacka), znacka)

    def test_razeni_znacek(self):
        # předchozí běh se hledá lexikograficky - značky musí řadit správně
        self.assertLess("2026-07", "2026-08")
        self.assertLess("2026-W31", "2026-W32")
        self.assertLess("2026-08-04", "2026-08-05")


class TestXmlUlohy(unittest.TestCase):
    def _config(self, obdobi="mesicne", **planovac_cfg):
        return {"obdobi": obdobi,
                "planovac": {"den_v_mesici": 2, "cas": "09:30", **planovac_cfg}}

    def test_mesicni(self):
        xml = planovac.vytvor_xml_ulohy(
            "C:\\Apps\\monitor", self._config(), '"C:\\Apps\\monitor\\run.bat" --tichy')
        self.assertIn("<ScheduleByMonth>", xml)
        self.assertIn("<Day>2</Day>", xml)
        self.assertIn("<StartWhenAvailable>true</StartWhenAvailable>", xml)
        self.assertIn("run.bat", xml)
        self.assertIn("<RunLevel>LeastPrivilege</RunLevel>", xml)

    def test_tydenni_a_denni(self):
        self.assertIn("<ScheduleByWeek>", planovac.vytvor_xml_ulohy(
            "C:\\x", self._config("tydne"), "py x.pyz"))
        self.assertIn("<ScheduleByDay>", planovac.vytvor_xml_ulohy(
            "C:\\x", self._config("denne"), "py x.pyz"))

    def test_spatne_hodnoty(self):
        with self.assertRaises(ValueError):
            planovac.vytvor_xml_ulohy("C:\\x", {"obdobi": "rocne"}, "x")
        with self.assertRaises(ValueError):
            planovac.vytvor_xml_ulohy("C:\\x", self._config(cas="devet"), "x")


if __name__ == "__main__":
    unittest.main()
