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
          stejná pravidla.
        </p>
        <p>
          Poskytovatel přihlášení účtem jiné služby (např. Google) je samostatný správce - ověří
          vaši totožnost sám za sebe a řídí se{" "}
          <a href="https://policies.google.com/privacy">vlastními zásadami ochrany soukromí</a>.
        </p>
        <p>
          Do veřejných databází (e-Sbírka, Nejvyšší soud, Nejvyšší správní soud, Ústavní soud,
          rozhodnuti.justice.cz, InfoCuria, EUR-Lex) a knihovního katalogu UKAŽ Univerzity
          Karlovy (Primo) putuje pouze samotný dotaz, nikoli to, kdo jste. Údaje dále předám jen
          tehdy, uloží-li mi to zákon.
        </p>
      </Section>

      <Section heading="7. Předávání do třetích zemí">
        <p>
          Vaše rešerše Evropskou unii neopouští. Server běží v evropském regionu (Frankfurt) a
          databáze, do kterých se dotazuje, jsou české a unijní.
        </p>
        <p>
          Mimo Evropskou unii jde jediná věc - údaje o vašem účtu, které Clerk vede ve Spojených
          státech, a přístup k platformě Vercel, spravované rovněž odtamtud. Obojí se opírá o
          rozhodnutí Evropské komise o odpovídající ochraně pro EU-US Data Privacy Framework; obě
          společnosti jsou v tomto rámci zapsány.
        </p>
      </Section>

      <Section heading="8. Cookies">
        <p>
          Tyto stránky nenastavují žádné cookies. Cookies nutné k udržení přihlášení nastavuje na
          své vlastní adrese Clerk.
        </p>
      </Section>

      <Section heading="9. Zabezpečení a umístění dat">
        <p>
          Server běží v evropském regionu (Frankfurt). Komunikace probíhá výhradně přes šifrované
          spojení (HTTPS) a server odmítá neověřené požadavky.
        </p>
        <p>
          Nejvíc ale chrání to, co tu vůbec není. Vlastní databázi nevedu, takže neexistuje
          úložiště, ze kterého by šlo vaše dotazy zpětně vytáhnout. Co projde dočasnou pamětí, po
          minutách mizí a s vaším účtem to spojené není.
        </p>
        <p>
          Kromě mě mají k údajům přístup jen poskytovatelé uvedení výše a jejich dodavatelé, a to v
          rozsahu nutném k tomu, aby služba běžela.
        </p>
      </Section>

      <Section heading="10. Pověřenec pro ochranu osobních údajů">
        <p>
          Vzhledem k povaze a rozsahu zpracování nemám povinnost jmenovat pověřence a nejmenoval
          jsem jej. Ve všech věcech ochrany osobních údajů se obracejte přímo na <Mail />.
        </p>
      </Section>

      <Section heading="11. Vaše práva">
        <p>V souvislosti se svými údaji můžete uplatnit tato práva:</p>
        <ul style={list}>
          <li>
            <strong>Právo na přístup.</strong> Můžete se mě zeptat, zda o vás nějaké údaje
            zpracovávám, a chtít jejich kopii spolu s informací, k čemu je používám, jak dlouho je
            budu mít a komu se dostanou.
          </li>
          <li>
            <strong>Právo na opravu.</strong> Vedu-li o vás nepřesný údaj, opravím ho; je-li
            neúplný, doplním ho.
          </li>
          <li>
            <strong>Právo na výmaz.</strong> Můžete chtít, abych vaše údaje smazal - typicky když
            už je k původnímu účelu nepotřebuji nebo když jste úspěšně vznesli námitku. Účet a vše,
            co k němu patří, smažu na požádání bez zbytečného odkladu.
          </li>
          <li>
            <strong>Právo na omezení zpracování.</strong> Namítáte-li, že je údaj nepřesný nebo že
            zpracování nemá oporu, můžete chtít, abych s ním po dobu, než se to vyjasní, nedělal
            nic dalšího a jen ho uchoval.
          </li>
          <li>
            <strong>Právo na přenositelnost údajů.</strong> Údaje, které o vás zpracovávám
            automatizovaně pro plnění smlouvy, vám vydám ve strojově čitelném formátu, případně je
            na vaši žádost pošlu přímo jinému správci, je-li to technicky proveditelné.
          </li>
          <li>
            <strong>Právo vznést námitku.</strong> Proti zpracování, které stojí na oprávněném
            zájmu - údaje o používání služby, provozní záznamy a vaše zprávy - můžete kdykoli
            vznést námitku.
          </li>
          <li>
            <strong>Právo podat stížnost.</strong> Se stížností na to, jak s vašimi údaji
            nakládám, se můžete obrátit na Úřad pro ochranu osobních údajů, Pplk. Sochora 27, 170
            00 Praha 7, <a href="https://uoou.gov.cz">uoou.gov.cz</a>.
          </li>
        </ul>
        <p>
          Právo odvolat souhlas tu nenajdete proto, že žádný souhlas nemám a k ničemu ho
          nepotřebuji.
        </p>
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

      <Section heading="12. Změny těchto zásad">
        <p>
          Zásady mohu upravit, změní-li se fungování služby nebo právní úprava. Aktuální znění je
          vždy na této stránce a o podstatné změně vás budu informovat e-mailem.
        </p>
      </Section>
    </>
  );
}
