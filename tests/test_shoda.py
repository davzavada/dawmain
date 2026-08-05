import unittest

from monitor import shoda


class TestNormalizace(unittest.TestCase):
    def test_odstraneni_diakritiky(self):
        self.assertEqual(shoda.odstran_diakritiku("škoda"), "skoda")
        self.assertEqual(shoda.odstran_diakritiku("žluťoučký"), "zlutoucky")

    def test_dekodovani_idn(self):
        self.assertEqual(shoda.dekoduj_idn("xn--koda-f6a"), "škoda")
        self.assertEqual(shoda.dekoduj_idn("bezny-nazev"), "bezny-nazev")
        # neplatný punycode nesmí spadnout
        self.assertEqual(shoda.dekoduj_idn("xn--zzzzzz"), "xn--zzzzzz")

    def test_leet(self):
        self.assertEqual(shoda.leet_normalizuj("sk0da"), "skoda")
        self.assertEqual(shoda.leet_normalizuj("rnojefirma"), "mojefirma")


class TestLevenshtein(unittest.TestCase):
    def test_zakladni(self):
        self.assertEqual(shoda.levenshtein_do("skoda", "skoda", 2), 0)
        self.assertEqual(shoda.levenshtein_do("skoda", "skodo", 2), 1)
        self.assertEqual(shoda.levenshtein_do("skoda", "skda", 2), 1)
        self.assertEqual(shoda.levenshtein_do("skoda", "sokda", 2), 2)

    def test_prekroceni_meze(self):
        self.assertIsNone(shoda.levenshtein_do("skoda", "traktor", 2))
        self.assertIsNone(shoda.levenshtein_do("abc", "abcdefgh", 2))

    def test_mez_podle_delky(self):
        self.assertEqual(shoda.max_vzdalenost_pro("abcd"), 0)
        self.assertEqual(shoda.max_vzdalenost_pro("skoda"), 1)
        self.assertEqual(shoda.max_vzdalenost_pro("mojefirma"), 2)

    def test_preklep_v_textu(self):
        self.assertEqual(shoda.preklep_v_textu("skoda", "skooda", 1), 1)
        self.assertIsNone(shoda.preklep_v_textu("skoda", "kadernictvi", 1))


class TestShodyDomeny(unittest.TestCase):
    SLOVA = [("skoda", True)]

    def nalez(self, domena, slova=None):
        vysledek = shoda.najdi_shody_domeny(domena, slova or self.SLOVA)
        return vysledek[0].typ if vysledek else None

    def test_presna_shoda(self):
        self.assertEqual(self.nalez("autoskoda-plzen.cz"), "přesná shoda")
        self.assertEqual(self.nalez("skoda-dily.sk"), "přesná shoda")

    def test_idn(self):
        self.assertEqual(self.nalez("xn--koda-f6a.cz"), "diakritika/IDN")

    def test_vlozena_pomlcka(self):
        self.assertEqual(self.nalez("s-koda.cz"), "vložená pomlčka")

    def test_zamena_znaku(self):
        self.assertEqual(self.nalez("sk0da-eshop.sk"), "záměna znaků")

    def test_preklep(self):
        self.assertEqual(self.nalez("skooda.cz"), "překlep (vzdálenost 1)")

    def test_preklepy_vypnute(self):
        self.assertIsNone(self.nalez("skooda.cz", [("skoda", False)]))

    def test_kratke_slovo_bez_fuzzy(self):
        # slovo kratší než 5 znaků fuzzy nespouští, podřetězec ano
        self.assertEqual(self.nalez("cezdistribuce.cz", [("cez", True)]),
                         "přesná shoda")
        self.assertIsNone(self.nalez("cetro.cz", [("cez", True)]))

    def test_bez_shody(self):
        self.assertIsNone(self.nalez("obchod-online.cz"))
        self.assertIsNone(self.nalez("kadernictvi-praha.cz"))

    def test_ignorovana_domena(self):
        vysledek = shoda.najdi_shody_domeny(
            "skoda.cz", self.SLOVA, ignorovat=frozenset({"skoda.cz"}))
        self.assertEqual(vysledek, [])


class TestHromadneShody(unittest.TestCase):
    def test_konfigurace_a_diakritika_slova(self):
        domeny = {"skoda-dily.cz", "obchod-online.cz", "mojef1rma.cz"}
        konfigurace = [
            {"slovo": "Škoda", "preklepy": True},
            {"slovo": "mojefirma", "preklepy": True},
        ]
        nalezy = shoda.najdi_shody(domeny, konfigurace)
        podle_domeny = {n.domena: n for n in nalezy}
        self.assertIn("skoda-dily.cz", podle_domeny)
        self.assertEqual(podle_domeny["skoda-dily.cz"].slovo, "skoda")
        self.assertIn("mojef1rma.cz", podle_domeny)
        self.assertEqual(podle_domeny["mojef1rma.cz"].typ, "záměna znaků")
        self.assertNotIn("obchod-online.cz", podle_domeny)

    def test_vice_slov_na_jednu_domenu(self):
        nalezy = shoda.najdi_shody(
            {"skoda-mojefirma.cz"},
            [{"slovo": "skoda"}, {"slovo": "mojefirma"}],
        )
        self.assertEqual(len(nalezy), 2)


if __name__ == "__main__":
    unittest.main()
