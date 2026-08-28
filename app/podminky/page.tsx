import { LegalHeader, Mail, Section } from "../_legal";

export const metadata = {
  title: "Podmínky užití - Dawmain",
  description: "Dawmain je zdarma a nekomerčně. Co to znamená a co od služby čekat.",
};

export default function Podminky() {
  return (
    <>
      <LegalHeader title="Podmínky užití" />

      <p>Dawmain provozuji zdarma a ve volném čase jako nekomerční projekt.</p>

      <Section heading="Kdo to provozuje">
        <p>
          David Závada, fyzická osoba, mimo podnikání. Napsat mi můžete na <Mail />. Smlouva mezi
          námi vzniká založením uživatelského účtu, a připojíte-li se starším sdíleným přístupovým
          kódem, prvním použitím služby. Tak jako tak je bezúplatná.
        </p>
      </Section>

      <Section heading="Účet a slušné užívání">
        <p>
          Používejte prosím svůj vlastní účet a nepůjčujte ho dál. Za to, co se pod ním děje, včetně
          volání vašeho asistenta, odpovídáte vy. Totéž platí pro přístupový kód, pokud se
          připojujete ještě jím.
        </p>
        <p>
          Služba je na běžné rešerše. Nedělejte z ní prosím hromadné stahování databází - zdroje
          jsou cizí a jejich přetížení odnesou všichni ostatní. Když by někdo provoz ohrožoval, můžu
          jeho přístup dočasně omezit; ozvu se mu a domluvíme se.
        </p>
      </Section>

      <Section heading="Běží to, jak to běží">
        <p>
          Snažím se, aby server šlapal, ale dostupnost nezaručuji - výpadky zdrojů jsou úplně mimo
          mou kontrolu. Jak na tom databáze zrovna jsou, ukazují kontrolky na{" "}
          <a href="/">hlavní stránce</a>.
        </p>
        <p>
          Za správnost, úplnost ani aktuálnost obsahu ze zdrojů neručím, stejně jako za to, co z
          nich vyvodí váš AI asistent, nebo za rozhodnutí udělaná bez ověření v primárním zdroji.
          Službu dostáváte zdarma a takovou, jaká je. Práv, kterých se podle zákona vzdát nedá, vás
          tím samozřejmě nepřipravuji.
        </p>
      </Section>

      <Section heading="Konec a změny">
        <p>
          Účet můžete kdykoli zrušit - napište na <Mail />. Já můžu provoz ukončit s měsíčním
          předstihem, a když někdo tyhle podmínky vážně poruší, i hned.
        </p>
        <p>
          Podmínky můžu přiměřeně změnit, když se změní fungování služby nebo právní úprava. Nové
          znění dám sem a o důležité změně napíšu e-mailem s měsíčním předstihem. Když se vám změna
          nelíbí, můžete kdykoli do jejího účinku odejít; když zůstanete, platí, že vám nevadí.
        </p>
      </Section>
    </>
  );
}
