<img src="public/logo.svg" alt="" width="76" align="right">

# Dawmain

**David Závada**

Přístup k judikatuře a právním předpisům s AI by podle mě neměl být možný jen
přes komerční nástroje, ale v době, kdy jsou ta data dobře přístupná a provoz
je v zásadě zdarma, mi přišlo, že by měla existovat nekomerční alternativa.
Budu rád, pokud nástroj vyzkoušíte :)

## Jak to funguje?

Server nemá vlastní databázi - funguje jako nachytřený Google: vyhledává živě
přímo v oficiálních databázích. Právní předpisy bere přes API e-Sbírky, unijní
legislativu i legislativní materiály (návrhy, stanoviska, postoje EP a Rady)
z Cellaru (strojové rozhraní Úřadu pro publikace EU, které stojí za
EUR-Lexem). Konkrétně je napojený na judikaturu:

- Nejvyššího soudu - dostupné [zde](https://rozhodnuti.nsoud.cz)
- Nejvyššího správního soudu - dostupné [zde](https://vyhledavac.nssoud.cz)
- Ústavního soudu (NALUS) - dostupné [zde](https://nalus.usoud.cz)
- obecných soudů - dostupné [zde](https://rozhodnuti.justice.cz)
- Soudního dvora EU (InfoCuria) - dostupné [zde](https://infocuria.curia.europa.eu)

Právní předpisy: [e-Sbírka](https://www.e-sbirka.cz), unijní legislativa,
judikatura a legislativní materiály: [EUR-Lex](https://eur-lex.europa.eu).

Doktrína (knihy, kapitoly, články) přes katalogy dvou knihoven najednou:
[Peace Palace Library](https://peacepalace.on.worldcat.org) v Haagu (WorldCat
Discovery: WorldCat.org a licencované právnické kolekce knihovny) a
[UKAŽ](https://cuni.primo.exlibrisgroup.com/discovery/search?vid=420CKIS_INST:UKAZ)
Univerzity Karlovy (Primo: katalog UK a Central Discovery Index). Vrací
bibliografické záznamy s odkazem na záznam; kde existuje open-access kopie
(přes [Unpaywall](https://unpaywall.org) a DOI), umí stáhnout a číst i text
díla. Licencované tituly otevře přes proxy knihovny jako přihlášený čtenář,
pokud si uživatel na stránce [Účet](https://dawmain.davidzavada.cz/ucet)
uloží své čtenářské přihlášení (Peace Palace, UK); jinak vrátí aspoň celý
záznam — abstrakt a obsah.

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
