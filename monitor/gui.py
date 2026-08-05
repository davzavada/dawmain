"""Grafické rozhraní (tkinter) - vše podstatné na jedné obrazovce.

Spouští se příkazem `gui`; zabalené .exe bez argumentů ho otevírá rovnou.
Dlouhé akce (stahování seznamů) běží ve vedlejším vlákně, průběh se
vypisuje do okna přes frontu - tkinter se volá jen z hlavního vlákna.
"""

import io
import logging
import os
import queue
import re
import sys
import threading
from argparse import Namespace

import tkinter as tk
from tkinter import messagebox, ttk

from . import planovac, shoda

_OBDOBI = [("mesicne", "1× měsíčně"), ("tydne", "1× týdně (pondělí)"),
           ("denne", "každý den")]


class _DoFronty(io.TextIOBase):
    """Náhrada stdout/logování: řádky posílá do fronty pro okno."""

    def __init__(self, fronta):
        self.fronta = fronta

    def write(self, text):
        if text.strip():
            self.fronta.put(text.rstrip("\n"))
        return len(text)


class _LogDoFronty(logging.Handler):
    def __init__(self, fronta):
        super().__init__()
        self.fronta = fronta
        self.setFormatter(logging.Formatter("%(message)s"))

    def emit(self, zaznam):
        self.fronta.put(self.format(zaznam))


class Okno(tk.Tk):
    def __init__(self, jadro):
        super().__init__()
        self.jadro = jadro
        self.cesta_configu = os.path.join(jadro.KOREN, "config.json")
        self.config_data = jadro.nacti_config(self.cesta_configu)
        self.fronta = queue.Queue()
        self.bezi = False

        self.title("Monitoring domén .cz / .sk")
        self.minsize(720, 640)
        self._postav()
        self._nacti_do_formulare()

        jadro._nastav_logovani(os.path.join(jadro.KOREN, "data"))
        logging.getLogger().addHandler(_LogDoFronty(self.fronta))

        self.protocol("WM_DELETE_WINDOW", self._zavri)
        self.after(150, self._zpracuj_frontu)

    # -- stavba okna --------------------------------------------------------

    def _postav(self):
        hlavni = ttk.Frame(self, padding=10)
        hlavni.pack(fill="both", expand=True)

        # klíčová slova
        ram_slova = ttk.LabelFrame(hlavni, text="Klíčová slova", padding=8)
        ram_slova.pack(fill="x")
        self.seznam_slov = tk.Listbox(ram_slova, height=6)
        self.seznam_slov.grid(row=0, column=0, columnspan=3, sticky="ew")
        ram_slova.columnconfigure(0, weight=1)
        self.nove_slovo = ttk.Entry(ram_slova)
        self.nove_slovo.grid(row=1, column=0, sticky="ew", pady=(6, 0))
        self.nove_slovo.bind("<Return>", lambda _u: self._pridej_slovo())
        self.hlidat_preklepy = tk.BooleanVar(value=True)
        ttk.Checkbutton(ram_slova, text="hlídat i překlepy",
                        variable=self.hlidat_preklepy).grid(
            row=1, column=1, padx=6, pady=(6, 0))
        ttk.Button(ram_slova, text="Přidat",
                   command=self._pridej_slovo).grid(row=1, column=2, pady=(6, 0))
        ttk.Button(ram_slova, text="Odebrat vybrané",
                   command=self._odeber_slovo).grid(
            row=2, column=2, pady=(6, 0), sticky="e")

        # nastavení běhu
        ram_beh = ttk.LabelFrame(hlavni, text="Kdy kontrolovat", padding=8)
        ram_beh.pack(fill="x", pady=(8, 0))
        ttk.Label(ram_beh, text="Období:").grid(row=0, column=0, sticky="w")
        self.obdobi = ttk.Combobox(ram_beh, state="readonly", width=18,
                                   values=[popis for _, popis in _OBDOBI])
        self.obdobi.grid(row=0, column=1, sticky="w", padx=(4, 12))
        ttk.Label(ram_beh, text="Den v měsíci:").grid(row=0, column=2, sticky="w")
        self.den = ttk.Spinbox(ram_beh, from_=1, to=28, width=4)
        self.den.grid(row=0, column=3, sticky="w", padx=(4, 12))
        ttk.Label(ram_beh, text="Čas:").grid(row=0, column=4, sticky="w")
        self.cas = ttk.Entry(ram_beh, width=7)
        self.cas.grid(row=0, column=5, sticky="w", padx=(4, 0))

        # zdroj .cz
        ram_cz = ttk.LabelFrame(hlavni, text="Zdroj dat pro .cz (viz README)",
                                padding=8)
        ram_cz.pack(fill="x", pady=(8, 0))
        ttk.Label(ram_cz, text="URL seznamu domén:").grid(row=0, column=0,
                                                          sticky="w")
        self.cz_url = ttk.Entry(ram_cz)
        self.cz_url.grid(row=0, column=1, sticky="ew", padx=(4, 0))
        ram_cz.columnconfigure(1, weight=1)
        self.cz_rdap = tk.BooleanVar(value=False)
        ttk.Checkbutton(
            ram_cz, variable=self.cz_rdap,
            text="záložní režim RDAP (bez seznamu; jen kandidátní jména)",
        ).grid(row=1, column=0, columnspan=2, sticky="w", pady=(4, 0))

        # akce
        ram_akce = ttk.Frame(hlavni)
        ram_akce.pack(fill="x", pady=(10, 0))
        self.tlacitka = []
        for text, akce in [
            ("Uložit nastavení", self._uloz),
            ("Ověřit zdroje", self._over_zdroje),
            ("Spustit teď", self._spust_ted),
            ("Naplánovat automatiku", self._naplanuj),
            ("Otevřít poslední report", self._otevri_report),
        ]:
            tlacitko = ttk.Button(ram_akce, text=text, command=akce)
            tlacitko.pack(side="left", padx=(0, 6))
            self.tlacitka.append(tlacitko)

        # průběh
        ram_log = ttk.LabelFrame(hlavni, text="Průběh", padding=4)
        ram_log.pack(fill="both", expand=True, pady=(10, 0))
        self.log = tk.Text(ram_log, height=12, state="disabled", wrap="word")
        posuvnik = ttk.Scrollbar(ram_log, command=self.log.yview)
        self.log.configure(yscrollcommand=posuvnik.set)
        self.log.pack(side="left", fill="both", expand=True)
        posuvnik.pack(side="right", fill="y")

    # -- formulář <-> config ------------------------------------------------

    def _nacti_do_formulare(self):
        cfg = self.config_data
        self._prekresli_slova()
        klice = [klic for klic, _ in _OBDOBI]
        try:
            self.obdobi.current(klice.index(cfg.get("obdobi", "mesicne")))
        except ValueError:
            self.obdobi.current(0)
        plan = cfg.get("planovac", {})
        self.den.delete(0, "end")
        self.den.insert(0, str(plan.get("den_v_mesici", 2)))
        self.cas.delete(0, "end")
        self.cas.insert(0, str(plan.get("cas", "09:30")))
        cz = cfg.get("zdroje", {}).get("cz", {})
        urls = [u for u in cz.get("urls", []) if u]
        self.cz_url.delete(0, "end")
        if urls:
            self.cz_url.insert(0, urls[0])
        self.cz_rdap.set(cz.get("rezim", "auto") == "rdap")

    def _prekresli_slova(self):
        self.seznam_slov.delete(0, "end")
        for polozka in self.config_data.get("klicova_slova", []):
            dodatek = "" if polozka.get("preklepy", True) else "   (bez překlepů)"
            self.seznam_slov.insert("end", polozka.get("slovo", "?") + dodatek)

    def _sesbirej(self) -> bool:
        """Přenese formulář do config_data; False = neplatný vstup."""
        cfg = self.config_data
        cfg["obdobi"] = _OBDOBI[self.obdobi.current()][0]
        cas = self.cas.get().strip()
        try:
            den = int(self.den.get())
            if not 1 <= den <= 28:
                raise ValueError
        except ValueError:
            messagebox.showerror("Neplatný den",
                                 "Den v měsíci musí být číslo 1-28.")
            return False
        if not re.fullmatch(r"\d{2}:\d{2}", cas):
            messagebox.showerror("Neplatný čas",
                                 "Čas musí mít formát HH:MM, např. 09:30.")
            return False
        cfg.setdefault("planovac", {})
        cfg["planovac"]["den_v_mesici"] = den
        cfg["planovac"]["cas"] = cas
        cz = cfg.setdefault("zdroje", {}).setdefault("cz", {})
        url = self.cz_url.get().strip()
        cz["urls"] = [url] if url else []
        cz["rezim"] = "rdap" if self.cz_rdap.get() else "auto"
        return True

    def _uloz(self, potichu=False) -> bool:
        if not self._sesbirej():
            return False
        self.jadro.uloz_config(self.cesta_configu, self.config_data)
        if not potichu:
            self.fronta.put("Nastavení uloženo do config.json.")
        return True

    # -- klíčová slova ------------------------------------------------------

    def _pridej_slovo(self):
        slovo = self.nove_slovo.get().strip().lower()
        if not slovo:
            return
        normalizovane = shoda.normalizuj_slovo(slovo)
        slova = self.config_data.setdefault("klicova_slova", [])
        if any(shoda.normalizuj_slovo(p.get("slovo", "")) == normalizovane
               for p in slova):
            messagebox.showinfo("Klíčová slova",
                                "Slovo „%s“ už je nastavené." % slovo)
            return
        slova.append({"slovo": slovo,
                      "preklepy": bool(self.hlidat_preklepy.get())})
        self.nove_slovo.delete(0, "end")
        self._prekresli_slova()
        self._uloz(potichu=True)
        self.fronta.put("Přidáno klíčové slovo „%s“." % slovo)

    def _odeber_slovo(self):
        vyber = self.seznam_slov.curselection()
        if not vyber:
            return
        slova = self.config_data.get("klicova_slova", [])
        for index in reversed(vyber):
            if 0 <= index < len(slova):
                self.fronta.put("Odebráno slovo „%s“."
                                % slova[index].get("slovo", "?"))
                del slova[index]
        self._prekresli_slova()
        self._uloz(potichu=True)

    # -- akce na pozadí -----------------------------------------------------

    def _spust_na_pozadi(self, prace):
        if self.bezi:
            return
        if not self._uloz(potichu=True):
            return
        self.bezi = True
        for tlacitko in self.tlacitka:
            tlacitko.state(["disabled"])

        def obal():
            puvodni_stdout = sys.stdout
            try:
                sys.stdout = _DoFronty(self.fronta)
                prace()
            except Exception as chyba:      # GUI nesmí spadnout kvůli akci
                self.fronta.put("CHYBA: %s" % chyba)
            finally:
                sys.stdout = puvodni_stdout
                self.fronta.put(("__konec__",))

        threading.Thread(target=obal, daemon=True).start()

    def _over_zdroje(self):
        volby = Namespace(offline_cz=None, offline_sk=None)
        self._spust_na_pozadi(
            lambda: self.jadro.over_zdroje(self.config_data, volby))

    def _spust_ted(self):
        jadro = self.jadro
        znacka = planovac.znacka_obdobi(self.config_data.get("obdobi", "mesicne"))
        volby = Namespace(obdobi=znacka, znovu=True, jen_tld=None,
                          offline_cz=None, offline_sk=None, tichy=True)

        def prace():
            sklad = jadro.uloziste.Uloziste(os.path.join(jadro.KOREN, "data"))
            try:
                jadro.spustit_beh(self.config_data, sklad, volby)
            finally:
                sklad.zavri()
            cesta = os.path.join(jadro.KOREN, "reporty", "%s.html" % znacka)
            if os.path.exists(cesta) and hasattr(os, "startfile"):
                os.startfile(cesta)

        self._spust_na_pozadi(prace)

    def _naplanuj(self):
        volby = Namespace(prikaz="nastav-planovac", vystup=None)
        self._spust_na_pozadi(
            lambda: self.jadro.sprava_planovace(self.config_data, volby))

    def _otevri_report(self):
        cesta = os.path.join(self.jadro.KOREN, "reporty", "index.html")
        if not os.path.exists(cesta):
            messagebox.showinfo("Reporty", "Zatím žádný report nevznikl - "
                                           "použij „Spustit teď“.")
            return
        if hasattr(os, "startfile"):
            os.startfile(cesta)
        else:
            self.fronta.put("Přehled reportů: %s" % cesta)

    # -- obsluha fronty a zavření -------------------------------------------

    def _zpracuj_frontu(self):
        try:
            while True:
                polozka = self.fronta.get_nowait()
                if polozka == ("__konec__",):
                    self.bezi = False
                    for tlacitko in self.tlacitka:
                        tlacitko.state(["!disabled"])
                    continue
                self.log.configure(state="normal")
                self.log.insert("end", str(polozka) + "\n")
                self.log.see("end")
                self.log.configure(state="disabled")
        except queue.Empty:
            pass
        self.after(150, self._zpracuj_frontu)

    def _zavri(self):
        if not self.bezi:
            self._uloz(potichu=True)
        self.destroy()


def spust_gui(jadro) -> int:
    okno = Okno(jadro)
    okno.mainloop()
    return 0
