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
          <strong>David Závada</strong>, fyzická osoba, služba je provozována mimo rámec
          podnikatelské činnosti.
        </p>
        <p>
          E-mail: <Mail />
        </p>
      </Section>

      <Section heading="2. Jaké údaje zpracovávám">
        <p>Při přihlášení a používání služby zpracovávám tyto údaje:</p>
        <ul style={list}>
          <li>
            <strong>e-mailová adresa</strong> - pro rozlišení uživatelů a komunikaci s vámi,
          </li>
          <li>
            <strong>identifikátor účtu</strong> - pro jednoznačné přiřazení uživatele,
          </li>
          <li>
            <strong>strojová volání nástrojů a odpovědi zdrojů</strong> - krátce v dočasné paměti
            serveru, aby opakovaný dotaz nezatěžoval veřejné zdroje,
          </li>
          <li>
            <strong>údaje o používání služby</strong> - která volání server odbaví, kolik jich je a
            jak dopadnou,
          </li>
          <li>
            <strong>provozní záznamy hostingu</strong> - IP adresa, čas, typ požadavku, chybová
            hlášení.
          </li>
        </ul>
        <p>
          Účty vede poskytovatel přihlášení Clerk; drží e-mailovou adresu a identifikátor účtu.
          Přihlásíte-li se přes účet jiné služby (např. Google), předá do Clerku zpravidla totéž.
          Žádné další údaje z vašeho účtu nezpracovávám a hesla u sebe neuchovávám.
        </p>
        <p>
          Vaši konverzaci s AI asistentem server nevidí - nedostává ji. Dostane jen strojové
          volání, které asistent provede. Vlastní databázi nevedu a nic si trvale neukládám.
          Reklamu nemám, údaje neprodávám a nepředávám je pro marketing. Nic o vás automaticky
          nevyhodnocuji ani neprofiluji.
        </p>
      </Section>

      <Section heading="3. Účel zpracování">
        <ul style={list}>
          <li>umožnění přihlášení a přístupu ke službě,</li>
          <li>udržení přihlašovací relace,</li>
          <li>vyřízení rešerše; krátká mezipaměť šetří zdroje, ze kterých se čerpá,</li>
          <li>přehled o tom, jak se služba používá, a její další zlepšování,</li>
          <li>provoz a bezpečnost služby a prevence jejího zneužití.</li>
        </ul>
      </Section>

      <Section heading="4. Právní základ zpracování">
        <p>
          Účet, přihlašovací relaci a vyřízení rešerše včetně krátké dočasné paměti zpracovávám pro
          plnění smlouvy (čl. 6 odst. 1 písm. b) GDPR). Skutečnost, že je služba bezúplatná, na tom
          nic nemění.
        </p>
        <p>
          Údaje o používání služby, provozní záznamy hostingu a zprávy, které mi napíšete,
          zpracovávám na základě oprávněného zájmu (čl. 6 odst. 1 písm. f) GDPR) na tom, aby služba
          dobře fungovala, byla bezpečná a abych vyřídil, s čím se na mě obracíte.
        </p>
      </Section>

      <Section heading="5. Doba uchování">
        <ul style={list}>
          <li>údaje o účtu - dokud účet trvá,</li>
          <li>přihlašovací relace - do svého vypršení,</li>
          <li>dočasná paměť - vyhledávání nejdéle 5 minut, texty rozhodnutí a předpisů nejdéle 10 minut,</li>
          <li>údaje o používání služby - nejdéle 12 měsíců,</li>
          <li>provozní záznamy hostingu - krátkodobě, v řádu dnů až týdnů,</li>
          <li>e-mailová korespondence - po dobu potřebnou k vyřízení věci, nejdéle rok.</li>
        </ul>
        <p>
          O smazání účtu a všech souvisejících údajů můžete požádat na <Mail />. Provedu je bez
          zbytečného odkladu.
        </p>
      </Section>

      <Section heading="6. Sdílení údajů s třetími stranami">
        <p>
          Vaše osobní údaje nepředávám nikomu k jeho vlastním účelům a neprodávám je. Na provozu se
          podílejí dva zpracovatelé, se kterými mám uzavřenou smlouvu o zpracování osobních údajů:
        </p>
        <ul style={list}>
          <li>
            <strong>Clerk, Inc.</strong> - přihlašování a správa účtů; společnost sídlí v USA a
            účty vede tam,
          </li>
          <li>
            <strong>Vercel, Inc.</strong> - hosting serveru; server běží v evropském regionu
            (Frankfurt), platforma americké společnosti je ale přístupná z USA.
          </li>
        </ul>
        <p>
          Oba si k plnění své role přibírají vlastní dodavatele (infrastruktura datových center,
          služba pro odesílání ověřovacích e-mailů), které váže stejná povinnost mlčenlivosti a
          stejná pravidla. Předání do Spojených států se opírá o rozhodnutí Evropské komise o
          odpovídající ochraně pro EU-US Data Privacy Framework; obě společnosti jsou v tomto rámci
          zapsány.
        </p>
        <p>
          Poskytovatel přihlášení účtem jiné služby (např. Google) je samostatný správce - ověří
          vaši totožnost sám za sebe a řídí se{" "}
          <a href="https://policies.google.com/privacy">vlastními zásadami ochrany soukromí</a>.
        </p>
        <p>
          Do veřejných databází (e-Sbírka, Nejvyšší soud, Nejvyšší správní soud, Ústavní soud,
          rozhodnuti.justice.cz, InfoCuria, EUR-Lex) putuje pouze samotný dotaz, nikoli to, kdo
          jste. Údaje dále předám jen tehdy, uloží-li mi to zákon.
        </p>
      </Section>

      <Section heading="7. Cookies">
        <p>
          Tyto stránky nenastavují žádné cookies. Cookies nutné k udržení přihlášení nastavuje na
          své vlastní adrese Clerk.
        </p>
      </Section>

      <Section heading="8. Zabezpečení údajů">
        <p>
          Komunikace probíhá výhradně přes šifrované spojení (HTTPS) a server odmítá neověřené
          požadavky. Kromě mě mají k údajům přístup jen poskytovatelé uvedení výše a jejich
          dodavatelé, a to v rozsahu nutném k tomu, aby služba běžela.
        </p>
      </Section>

      <Section heading="9. Pověřenec pro ochranu osobních údajů">
        <p>
          Vzhledem k povaze a rozsahu zpracování nemám povinnost jmenovat pověřence a nejmenoval
          jsem jej. Ve všech věcech ochrany osobních údajů se obracejte přímo na <Mail />.
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
          Pro uplatnění svých práv mě kontaktujte na <Mail />. Vyřídím je zdarma a bez zbytečného
          odkladu, nejpozději do měsíce od doručení žádosti. Je-li žádost složitá, mohu lhůtu
          prodloužit až o další dva měsíce; do měsíce vám pak dám vědět, že ji prodlužuji a proč.
        </p>
        <p>
          Vznesete-li námitku, údaje dál zpracovávat nebudu, ledaže prokážu závažné oprávněné
          důvody, které převažují nad vašimi zájmy, právy a svobodami.
        </p>
      </Section>

      <Section heading="11. Změny těchto zásad">
        <p>
          Zásady mohu upravit, změní-li se fungování služby nebo právní úprava. Aktuální znění je
          vždy na této stránce a o podstatné změně vás budu informovat e-mailem.
        </p>
      </Section>
    </>
  );
}
