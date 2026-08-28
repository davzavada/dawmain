import { LegalHeader, Mail, Section, list } from "../_legal";

export const metadata = {
  title: "Zásady ochrany osobních údajů - Dawmain",
  description: "Jaké osobní údaje Dawmain zpracovává, proč, jak dlouho a jaká máte práva.",
};

export default function Soukromi() {
  return (
    <>
      <LegalHeader title="Zásady ochrany osobních údajů" />

      <Section heading="1. Správce osobních údajů">
        <p>
          Správcem osobních údajů je <strong>David Závada</strong>, fyzická osoba, která službu
          Dawmain provozuje mimo rámec podnikatelské činnosti.
        </p>
        <p>
          Kontaktní e-mail: <Mail />
        </p>
      </Section>

      <Section heading="2. Jaké údaje zpracovávám">
        <p>Při přihlášení k službě zpracovávám tyto osobní údaje:</p>
        <ul style={list}>
          <li>
            <strong>e-mailová adresa</strong> - pro identifikaci uživatele a případnou komunikaci,
          </li>
          <li>
            <strong>jméno</strong> - pro zobrazení v rozhraní, pokud je předá zvolený způsob
            přihlášení,
          </li>
          <li>
            <strong>profilová fotografie</strong> - pro zobrazení v rozhraní, pokud ji zvolený
            způsob přihlášení předá; načítá se přímo od poskytovatele a na mém serveru se neukládá,
          </li>
          <li>
            <strong>identifikátor uživatele</strong> u poskytovatele přihlášení - pro jednoznačné
            přiřazení účtu,
          </li>
          <li>
            <strong>údaje o přihlášení</strong> - čas a technické údaje relace nutné k jejímu
            udržení.
          </li>
        </ul>
        <p>
          Server dále běží na hostingu, který o požadavcích vede standardní technický záznam (IP
          adresa, čas, typ požadavku, chybová hlášení).
        </p>
        <p>
          <strong>Obsah vašich dotazů neukládám.</strong> Server nemá vlastní databázi. Dotaz jím
          projde do veřejné databáze, odpověď se vrátí a nejdéle deset minut může zůstat v dočasné
          paměti serveru, aniž by byl spojen s vaším účtem. Neuchovávám hesla, protože přihlášení
          zajišťuje poskytovatel. Nepoužívám analytické ani reklamní nástroje, neprovádím
          profilování ani automatizované rozhodování a nezpracovávám zvláštní kategorie údajů,
          jako je zdravotní stav či názory.
        </p>
      </Section>

      <Section heading="3. Účel zpracování">
        <ul style={list}>
          <li>umožnění přihlášení a přístupu ke službě,</li>
          <li>udržení přihlašovací relace,</li>
          <li>zobrazení jména uživatele v rozhraní,</li>
          <li>zajištění provozu a bezpečnosti služby a prevence jejího zneužití,</li>
          <li>odpověď na vaši zprávu, pokud mi napíšete.</li>
        </ul>
      </Section>

      <Section heading="4. Právní základ zpracování">
        <p>
          Údaje o účtu zpracovávám proto, abych vám mohl poskytnout službu, o kterou jste
          přihlášením projevili zájem, tedy pro splnění toho, na čem jsme se dohodli. Skutečnost, že
          je služba bezúplatná, na tom nic nemění.
        </p>
        <p>
          Provozní záznamy a opatření proti zneužití zpracovávám na základě svého oprávněného zájmu
          na tom, aby služba fungovala a byla zabezpečená. Proti tomuto zpracování můžete kdykoli
          vznést námitku na <Mail />.
        </p>
      </Section>

      <Section heading="5. Cookies">
        <p>
          Používám výhradně technicky nezbytné cookies, které udrží vaše přihlášení. Jsou chráněny
          příznaky Secure, HttpOnly a SameSite. Protože bez nich by přihlášení nefungovalo,
          nevyžaduje se k nim souhlas. Analytické ani reklamní cookies na stránkách nejsou.
        </p>
      </Section>

      <Section heading="6. Doba uchování">
        <ul style={list}>
          <li>údaje o účtu - po dobu trvání účtu,</li>
          <li>přihlašovací relace - do jejího vypršení,</li>
          <li>provozní záznamy hostingu - krátkodobě, v řádu dnů až týdnů.</li>
        </ul>
        <p>
          O zrušení účtu a smazání všech souvisejících údajů můžete požádat na <Mail />. Provedu je
          bez zbytečného odkladu.
        </p>
      </Section>

      <Section heading="7. Sdílení údajů s třetími stranami">
        <p>
          Vaše osobní údaje nepředávám třetím stranám k jejich vlastním účelům. Na provozu služby se
          podílejí dva zpracovatelé, se kterými mám uzavřenu smlouvu o zpracování osobních údajů:
        </p>
        <ul style={list}>
          <li>
            <strong>Clerk, Inc.</strong> - přihlašování a správa uživatelských účtů. Společnost
            sídlí ve Spojených státech a údaje o účtu zpracovává tam.
          </li>
          <li>
            <strong>Vercel, Inc.</strong> - hosting serveru. Server běží v evropském regionu ve
            Frankfurtu, provozovatelem je americká společnost.
          </li>
        </ul>
        <p>
          Obě společnosti jsou certifikovány v rámci EU-US Data Privacy Framework, takže se předání
          údajů do Spojených států opírá o rozhodnutí Evropské komise o odpovídající ochraně.
          Bližší informace vám na požádání poskytnu. Údaje dále předám pouze tehdy, uloží-li mi to
          zákon.
        </p>
        <p>
          Vaše dotazy server odesílá do veřejných databází (e-Sbírka, Nejvyšší soud, Nejvyšší
          správní soud, Ústavní soud, rozhodnuti.justice.cz, InfoCuria, EUR-Lex). Odesílá se jim
          pouze samotný dotaz, nikoli vaše totožnost. Tyto instituce jsou samostatnými správci a
          řídí se vlastními pravidly.
        </p>
      </Section>

      <Section heading="8. Zabezpečení údajů">
        <p>
          Komunikace probíhá výhradně přes šifrované spojení (HTTPS). K údajům mám přístup pouze já
          a zpracovatelé uvedení výše. Server odmítá neověřené požadavky a hesla u sebe neuchovávám.
        </p>
      </Section>

      <Section heading="9. Pověřenec pro ochranu osobních údajů">
        <p>
          Vzhledem k povaze a rozsahu zpracování nemám povinnost jmenovat pověřence pro ochranu
          osobních údajů a nejmenoval jsem jej. Ve všech věcech ochrany osobních údajů se proto
          obracejte přímo na <Mail />.
        </p>
      </Section>

      <Section heading="10. Vaše práva">
        <p>Máte právo:</p>
        <ul style={list}>
          <li>na přístup ke svým osobním údajům a na jejich kopii,</li>
          <li>na opravu nepřesných údajů,</li>
          <li>na výmaz údajů (právo být zapomenut),</li>
          <li>na omezení zpracování,</li>
          <li>na přenositelnost údajů,</li>
          <li>vznést námitku proti zpracování založenému na oprávněném zájmu,</li>
          <li>
            podat stížnost u Úřadu pro ochranu osobních údajů, Pplk. Sochora 27, 170 00 Praha 7,{" "}
            <a href="https://uoou.gov.cz">uoou.gov.cz</a>.
          </li>
        </ul>
        <p>
          Pro uplatnění svých práv mě kontaktujte na <Mail />. Ozvu se bez zbytečného odkladu,
          nejpozději do jednoho měsíce.
        </p>
      </Section>

      <Section heading="11. Změny těchto zásad">
        <p>
          Zásady mohu upravit, pokud se změní fungování služby nebo právní úprava. Aktuální znění je
          vždy na této stránce a o podstatné změně vás budu informovat e-mailem.
        </p>
      </Section>
    </>
  );
}
