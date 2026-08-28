import { LegalHeader, Mail, Section, list } from "../_legal";

export const metadata = {
  title: "Podmínky užití - Dawmain",
  description: "Dawmain je zdarma a nekomerčně. Co to znamená a co od služby čekat.",
};

export default function Podminky() {
  return (
    <>
      <LegalHeader title="Podmínky užití" />

      <p>
        Dawmain provozuji zdarma a ve volném čase jako nekomerční projekt. Nic neplatíte a nic
        platit nebudete, takže tu není co řešit kolem plateb, faktur ani limitů. Zbývá pár věcí,
        které je fér říct dopředu.
      </p>

      <Section heading="Kdo to provozuje">
        <p>
          David Závada, fyzická osoba, mimo podnikání. Napsat mi můžete na <Mail />. Smlouva mezi
          námi vzniká vaším prvním přihlášením a je bezúplatná.
        </p>
      </Section>

      <Section heading="Nejsou to právní rady">
        <p>
          Tohle je to nejdůležitější z celé stránky. Služba jen zpřístupňuje veřejné zdroje —
          rozhodnutí soudů a znění právních předpisů. Vlastní databázi nemá, ptá se živě přímo
          těchto zdrojů.
        </p>
        <ul style={list}>
          <li>
            Výstupy jsou <strong>informace, ne právní rada</strong>, a neposkytuji jimi právní
            služby.
          </li>
          <li>
            Odpovědi formuluje <strong>váš AI asistent</strong> od třetí strany. Já dodávám jen
            přístup k datům — co z nich asistent vyvodí, neovlivním.
          </li>
          <li>
            Data mohou být neúplná, zastaralá nebo chybná už u zdroje.{" "}
            <strong>Co je pro vás důležité, ověřte si v primárním zdroji</strong> — odkaz k tomu
            dostanete u každého výsledku.
          </li>
        </ul>
      </Section>

      <Section heading="Účet a slušné užívání">
        <p>
          Používejte prosím svůj vlastní účet a nepůjčujte ho dál. Za to, co se pod ním děje, včetně
          volání vašeho asistenta, odpovídáte vy.
        </p>
        <p>
          Služba je na běžné rešerše. Nedělejte z ní prosím hromadné stahování databází — zdroje
          jsou cizí a jejich přetížení odnesou všichni ostatní. Když to někdo přežene, můžu jeho
          účet dočasně přibrzdit; dám mu vědět a domluvíme se.
        </p>
      </Section>

      <Section heading="Běží to, jak to běží">
        <p>
          Snažím se, aby server šlapal, ale dostupnost nezaručuji — výpadky zdrojů jsou úplně mimo
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
          Účet můžete kdykoli zrušit — napište na <Mail />. Já můžu provoz ukončit s měsíčním
          předstihem, a když někdo tyhle podmínky vážně poruší, i hned.
        </p>
        <p>
          Podmínky můžu přiměřeně změnit, když se změní fungování služby nebo právní úprava. Nové
          znění dám sem a o důležité změně napíšu e-mailem s měsíčním předstihem. Když se vám změna
          nelíbí, můžete kdykoli do jejího účinku odejít; když zůstanete, platí, že vám nevadí.
        </p>
      </Section>

      <Section heading="Ještě dvě věci">
        <p>
          Jak nakládám s osobními údaji, popisují{" "}
          <a href="/soukromi">Zásady ochrany osobních údajů</a>. Texty předpisů a rozhodnutí jsou
          úřední díla, autorské právo je nechrání; kód serveru je otevřený pod licencí MIT. Řídíme
          se českým právem a případné spory patří českým soudům.
        </p>
        <p style={{ color: "#6b7280", fontSize: "0.85rem" }}>Účinné od 28. 8. 2026.</p>
      </Section>
    </>
  );
}
