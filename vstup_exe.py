"""Vstupní bod pro zabalené Windows .exe (PyInstaller)."""

import sys

from monitor.__main__ import main

if __name__ == "__main__":
    sys.exit(main())
