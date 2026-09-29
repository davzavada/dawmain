<img src="public/logo.svg" alt="" width="76" align="right">

# Dawmain

**David Závada**

Přístup k judikatuře a právním předpisům s AI by podle mě neměl být možný jen
přes komerční nástroje, ale v době, kdy jsou ta data dobře přístupná a provoz
je v zásadě zdarma, mi přišlo, že by měla existovat nekomerční alternativa.
Budu rád, pokud nástroj vyzkoušíte :)

## Jak to funguje?

V oficiálních databázích server hledá živě - funguje jako nachytřený Google a
nic si z nich nekopíruje. Konkrétně je napojený na judikaturu:

- Nejvyššího soudu - dostupné [zde](https://rozhodnuti.nsoud.cz)
- Nejvyššího správního soudu - dostupné [zde](https://vyhledavac.nssoud.cz)
- Ústavního soudu (NALUS) - dostupné [zde](https://nalus.usoud.cz)
- obecných soudů - dostupné [zde](https://rozhodnuti.justice.cz)
- Soudního dvora EU (InfoCuria) - dostupné [zde](https://infocuria.curia.europa.eu)

Právní předpisy: [e-Sbírka](https://www.e-sbirka.cz), unijní legislativa,
judikatura a legislativní materiály: [EUR-Lex](https://eur-lex.europa.eu).

Doktrína (knihy, kapitoly, články) přes
[UKAŽ](https://cuni.primo.exlibrisgroup.com/discovery/search?vid=420CKIS_INST:UKAZ)
Univerzity Karlovy (Primo: katalog UK a Central Discovery Index licencovaných
e-zdrojů). Vrací bibliografické záznamy s odkazem na záznam a na vyžádání
jeden záznam v plném znění — celý abstrakt a obsah, podle kterých se pozná,
zda je dílo k věci. Text díla se nestahuje; k němu vede odkaz na záznam
(u licencovaných titulů přes vzdálený přístup UK). (Peace Palace Library
byla vyřazena: její WorldCat Discovery blokuje adresy serverů.)

**Vlastní zdroje (Pro).** Kdo má režim Pro (je zdarma, přiděluji ho ručně), si
na webu nahraje vlastní knihy, články, komentáře a vzory - pro sebe, nebo pro
celý tým. Dokument se převede na text přímo v prohlížeči, takže originál
počítač neopustí; na server jde jen text. Asistent v dokumentech pak hledá a
čte vedle oficiálních databází. Funguje to jen s přihlášením vlastním účtem,
ne se starším přístupovým kódem. Záloha to není, text svých dokumentů si ale
můžete stáhnout. Pravidla jsou v
[podmínkách užití](https://dawmain.davidzavada.cz/podminky), o datech v
[zásadách ochrany osobních údajů](https://dawmain.davidzavada.cz/soukromi).

**Zotero (Pro).** S režimem Pro a přihlášením vlastním účtem si na webu
(tlačítko „Připojit Zotero“) propojíte svou knihovnu na zotero.org. Asistent
v ní pak hledá a čte vedle oficiálních databází: záznamy, poznámky, anotace a
text příloh, v osobní knihovně i ve skupinách. Přístup je jen ke čtení -
Dawmain v Zoteru nic nezmění; klíč s právem zápisu odmítne. Když Zotero text
PDF nezaindexoval, Dawmain si soubor na dotaz stáhne, přečte a neuloží.
Odpojit jde kdykoli na webu nebo smazáním klíče na zotero.org. Řádek
„Zotero“ na hlavní stránce (ve skupině Vlastní zdroje), položka v nabídce
účtu a nástroje `zotero_*` se objeví, až bude Zotero na webu zapnuté.

## Endpoint

```
https://dawmain.davidzavada.cz/api/mcp
```

V aplikaci claude.ai: **Nastavení → Konektory → Přidat vlastní konektor** a
vložit adresu výše.

Po přidání konektoru se otevře přihlášení - stačí registrace e-mailem.
Starší přístupové kódy fungují dál.

---

Technická dokumentace: [docs/development.md](docs/development.md)
