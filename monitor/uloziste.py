"""Lokální úložiště: SQLite databáze běhů a nálezů + gzip snapshoty seznamů.

Vše leží ve složce data/ vedle aplikace - žádné zápisy mimo její adresář,
takže není potřeba žádné oprávnění správce. Běhy se klíčují značkou
období (RRRR-MM, RRRR-WTT nebo RRRR-MM-DD podle nastavení), která řadí
lexikograficky.
"""

import gzip
import logging
import os
import sqlite3

log = logging.getLogger("monitor")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS behy (
    id INTEGER PRIMARY KEY,
    obdobi TEXT NOT NULL,
    tld TEXT NOT NULL,
    spusteno TEXT NOT NULL,
    zdroj TEXT NOT NULL,
    pocet_domen INTEGER NOT NULL,
    pocet_novych INTEGER NOT NULL,
    vychozi_stav INTEGER NOT NULL,
    snapshot_soubor TEXT NOT NULL,
    UNIQUE (obdobi, tld)
);
CREATE TABLE IF NOT EXISTS nalezy (
    id INTEGER PRIMARY KEY,
    obdobi TEXT NOT NULL,
    tld TEXT NOT NULL,
    domena TEXT NOT NULL,
    slovo TEXT NOT NULL,
    typ TEXT NOT NULL,
    jistota TEXT NOT NULL DEFAULT 'vysoká',
    zdroj TEXT,
    registrator TEXT,
    UNIQUE (obdobi, domena, slovo)
);
-- Trvalá evidence všech domén, které aplikace kdy viděla. Díky ní je
-- "nová doména" definovaná jako "dosud neviděná", nezávisle na tom, jak
-- dlouhá je mezera mezi běhy a kolik zdrojů ji nahlásilo.
CREATE TABLE IF NOT EXISTS videne_domeny (
    domena TEXT PRIMARY KEY,
    tld TEXT NOT NULL,
    prvni_obdobi TEXT NOT NULL,
    zdroj TEXT
);
CREATE INDEX IF NOT EXISTS videne_tld ON videne_domeny (tld);
"""


class Uloziste:
    def __init__(self, koren: str):
        self.koren = koren
        self.slozka_snapshotu = os.path.join(koren, "snapshoty")
        os.makedirs(self.slozka_snapshotu, exist_ok=True)
        self.spojeni = sqlite3.connect(os.path.join(koren, "monitor.db"))
        self.spojeni.executescript(_SCHEMA)

    def zavri(self):
        self.spojeni.close()

    # -- běhy a snapshoty ---------------------------------------------------

    def beh_existuje(self, obdobi: str, tld: str) -> bool:
        radek = self.spojeni.execute(
            "SELECT 1 FROM behy WHERE obdobi = ? AND tld = ?", (obdobi, tld)
        ).fetchone()
        return radek is not None

    def predchozi_beh(self, obdobi: str, tld: str):
        """Poslední běh před daným obdobím (značky řadí lexikograficky)."""
        return self.spojeni.execute(
            "SELECT obdobi, snapshot_soubor FROM behy "
            "WHERE tld = ? AND obdobi < ? ORDER BY obdobi DESC LIMIT 1",
            (tld, obdobi),
        ).fetchone()

    def nacti_snapshot(self, soubor: str):
        cesta = os.path.join(self.slozka_snapshotu, soubor)
        if not os.path.exists(cesta):
            log.warning("Snapshot %s chybí, běh bude brán jako výchozí stav.", cesta)
            return None
        with gzip.open(cesta, "rt", encoding="utf-8") as f:
            return {radek.strip() for radek in f if radek.strip()}

    def uloz_snapshot(self, obdobi: str, tld: str, domeny) -> str:
        soubor = "%s-%s.txt.gz" % (tld, obdobi)
        cesta = os.path.join(self.slozka_snapshotu, soubor)
        docasna = cesta + ".tmp"
        with gzip.open(docasna, "wt", encoding="utf-8") as f:
            for domena in sorted(domeny):
                f.write(domena + "\n")
        os.replace(docasna, cesta)
        return soubor

    def uloz_beh(self, obdobi, tld, spusteno, zdroj, pocet_domen, pocet_novych,
                 vychozi_stav, snapshot_soubor):
        with self.spojeni:
            self.spojeni.execute(
                "INSERT INTO behy (obdobi, tld, spusteno, zdroj, pocet_domen, "
                "pocet_novych, vychozi_stav, snapshot_soubor) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT (obdobi, tld) DO UPDATE SET spusteno = excluded.spusteno, "
                "zdroj = excluded.zdroj, pocet_domen = excluded.pocet_domen, "
                "pocet_novych = excluded.pocet_novych, "
                "vychozi_stav = excluded.vychozi_stav, "
                "snapshot_soubor = excluded.snapshot_soubor",
                (obdobi, tld, spusteno, zdroj, pocet_domen, pocet_novych,
                 int(vychozi_stav), snapshot_soubor),
            )

    def behy_obdobi(self, obdobi: str):
        return self.spojeni.execute(
            "SELECT tld, spusteno, zdroj, pocet_domen, pocet_novych, vychozi_stav "
            "FROM behy WHERE obdobi = ? ORDER BY tld", (obdobi,)
        ).fetchall()

    def vsechna_obdobi(self):
        return [r[0] for r in self.spojeni.execute(
            "SELECT DISTINCT obdobi FROM behy ORDER BY obdobi DESC"
        )]

    # -- evidence viděných domén --------------------------------------------

    def zna_tld(self, tld: str) -> bool:
        """Proběhl už pro toto TLD nějaký běh? (rozhoduje o výchozím stavu)"""
        radek = self.spojeni.execute(
            "SELECT 1 FROM videne_domeny WHERE tld = ? LIMIT 1", (tld,)
        ).fetchone()
        return radek is not None

    def rozdel_na_nove(self, domeny, tld: str):
        """Vrátí podmnožinu domén, které v evidenci ještě nejsou."""
        if not domeny:
            return set()
        znamé = set()
        seznam = list(domeny)
        # SQLite má limit na počet parametrů dotazu, ptáme se po dávkách.
        for i in range(0, len(seznam), 500):
            davka = seznam[i:i + 500]
            otazniky = ",".join("?" * len(davka))
            znamé.update(r[0] for r in self.spojeni.execute(
                "SELECT domena FROM videne_domeny WHERE domena IN (%s)" % otazniky,
                davka,
            ))
        return {d for d in seznam if d not in znamé}

    def zaznamenej_videne(self, domeny, tld: str, obdobi: str, zdroj: str):
        with self.spojeni:
            self.spojeni.executemany(
                "INSERT OR IGNORE INTO videne_domeny "
                "(domena, tld, prvni_obdobi, zdroj) VALUES (?, ?, ?, ?)",
                [(d, tld, obdobi, zdroj) for d in domeny],
            )

    def pocet_videnych(self, tld: str) -> int:
        return self.spojeni.execute(
            "SELECT COUNT(*) FROM videne_domeny WHERE tld = ?", (tld,)
        ).fetchone()[0]

    def posledni_beh_pred(self, obdobi: str, tld: str):
        """Datum spuštění posledního běhu před daným obdobím (nebo None)."""
        radek = self.spojeni.execute(
            "SELECT spusteno FROM behy WHERE tld = ? AND obdobi < ? "
            "ORDER BY obdobi DESC LIMIT 1", (tld, obdobi)
        ).fetchone()
        return radek[0] if radek else None

    # -- nálezy -------------------------------------------------------------

    def uloz_nalezy(self, obdobi: str, tld: str, nalezy, registratori,
                    zdroje_domen=None):
        zdroje_domen = zdroje_domen or {}
        with self.spojeni:
            self.spojeni.execute(
                "DELETE FROM nalezy WHERE obdobi = ? AND tld = ?", (obdobi, tld)
            )
            self.spojeni.executemany(
                "INSERT OR IGNORE INTO nalezy "
                "(obdobi, tld, domena, slovo, typ, jistota, zdroj, registrator) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                [
                    (obdobi, tld, n.domena, n.slovo, n.typ, n.jistota,
                     zdroje_domen.get(n.domena), registratori.get(n.domena))
                    for n in nalezy
                ],
            )

    def nalezy_obdobi(self, obdobi: str, jistota=None):
        dotaz = ("SELECT slovo, domena, tld, typ, registrator, jistota, zdroj "
                 "FROM nalezy WHERE obdobi = ?")
        parametry = [obdobi]
        if jistota is not None:
            dotaz += " AND jistota = ?"
            parametry.append(jistota)
        return self.spojeni.execute(
            dotaz + " ORDER BY slovo, tld, domena", parametry).fetchall()

    def pocty_nalezu(self):
        """{období: počet nálezů} pro přehledovou stránku."""
        return dict(self.spojeni.execute(
            "SELECT obdobi, COUNT(*) FROM nalezy GROUP BY obdobi"
        ))

    # -- úklid --------------------------------------------------------------

    def uklid_snapshotu(self, uchovavat: int):
        """Ponechá jen posledních `uchovavat` snapshotů na každé TLD."""
        if uchovavat <= 0:
            return
        for (tld,) in self.spojeni.execute("SELECT DISTINCT tld FROM behy"):
            radky = self.spojeni.execute(
                "SELECT snapshot_soubor FROM behy WHERE tld = ? "
                "ORDER BY obdobi DESC", (tld,)
            ).fetchall()
            for (soubor,) in radky[uchovavat:]:
                cesta = os.path.join(self.slozka_snapshotu, soubor)
                if os.path.exists(cesta):
                    os.remove(cesta)
                    log.info("Smazán starý snapshot %s", soubor)
