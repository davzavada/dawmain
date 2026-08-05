"""Sestaví jednosouborovou distribuci aplikace: dist/monitoring-domen.pyz

Použití:  python vytvor-distribuci.py
Výsledný .pyz je spustitelný všude, kde je Python 3.9+:
  py monitoring-domen.pyz          (Windows; funguje i dvojklik)
  python3 monitoring-domen.pyz     (macOS/Linux)
"""

import os
import shutil
import tempfile
import zipapp

KOREN = os.path.dirname(os.path.abspath(__file__))
VYSTUP = os.path.join(KOREN, "dist", "monitoring-domen.pyz")

VSTUPNI_BOD = (
    "import sys\n"
    "from monitor.__main__ import main\n"
    "sys.exit(main())\n"
)


def main():
    os.makedirs(os.path.dirname(VYSTUP), exist_ok=True)
    with tempfile.TemporaryDirectory() as pracovni:
        shutil.copytree(
            os.path.join(KOREN, "monitor"),
            os.path.join(pracovni, "monitor"),
            ignore=shutil.ignore_patterns("__pycache__"),
        )
        with open(os.path.join(pracovni, "__main__.py"), "w", encoding="utf-8") as f:
            f.write(VSTUPNI_BOD)
        zipapp.create_archive(
            pracovni, VYSTUP,
            interpreter="/usr/bin/env python3",
            compressed=True,
        )
    print("Hotovo: %s (%d kB)" % (VYSTUP, os.path.getsize(VYSTUP) // 1024))


if __name__ == "__main__":
    main()
