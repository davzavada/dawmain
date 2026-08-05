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
    registrator TEXT,
    UNIQUE (obdobi, domena, slovo)
);
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

    # -- nálezy -------------------------------------------------------------

    def uloz_nalezy(self, obdobi: str, tld: str, nalezy, registratori):
        with self.spojeni:
            self.spojeni.execute(
                "DELETE FROM nalezy WHERE obdobi = ? AND tld = ?", (obdobi, tld)
            )
            self.spojeni.executemany(
                "INSERT OR IGNORE INTO nalezy (obdobi, tld, domena, slovo, typ, registrator) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                [
                    (obdobi, tld, n.domena, n.slovo, n.typ,
                     registratori.get(n.domena))
                    for n in nalezy
                ],
            )

    def nalezy_obdobi(self, obdobi: str):
        return self.spojeni.execute(
            "SELECT slovo, domena, tld, typ, registrator FROM nalezy "
            "WHERE obdobi = ? ORDER BY slovo, tld, domena", (obdobi,)
        ).fetchall()

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
