import Link from "next/link";
import { LegalHeader, Mail, Section } from "../_legal";

export const metadata = {
  title: "Zásady ochrany osobních údajů - Dawmain",
  description: "Jaké osobní údaje Dawmain zpracovává, proč, jak dlouho a jaká máte práva.",
};

export default function Soukromi() {
  return (
    <article className="legal">
      <LegalHeader title="Zásady ochrany osobních údajů" />

      <Section heading="1. Správce osobních údajů">
        <p>
          <strong>David Závada</strong>, fyzická osoba, služba je provozována mimo rámec
          podnikatelské činnosti.
        </p>
        <p>
          E-mail: <Mail />
        </p>
        <p>
          Výjimkou jsou osobní údaje v dokumentech, které nahrajete do Vlastních zdrojů - třeba
          jména účastníků v rozhodnutí nebo autorů článku. Jejich správcem jste vy (u týmové
          knihovny zpravidla kancelář nebo firma, za kterou tým vystupuje): vy rozhodujete, co
          nahrajete a komu to v týmu zpřístupníte. Já je zpracovávám jen jako zpracovatel, podle
          vašich pokynů a <Link href="/podminky">Podmínek užití</Link>.
        </p>
      </Section>

      <Section heading="2. Jaké údaje zpracovávám">
        <p>Při přihlášení a používání služby zpracovávám tyto údaje:</p>
        <ul>
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
        <p>Máte-li Vlastní zdroje (režim Pro), přibývá k tomu:</p>
        <ul>
          <li>
            <strong>text nahraných dokumentů</strong> - dokumenty se na text převádějí přímo ve
            vašem prohlížeči; původní soubor vaše zařízení neopustí a na server jde jen převedený
            text,
          </li>
          <li>
            <strong>metadata dokumentů</strong> - název, autoři, rok, typ dokumentu a podobně, a
            také název a velikost původního souboru,
          </li>
          <li>
            <strong>vyhledávací index</strong> - z textu odvozená slova, strany, oddíly, poznámky a
            identifikátory (spisové značky, paragrafy), ve kterých asistent hledá,
          </li>
          <li>
            <strong>kdo co udělal</strong> - kdo a kdy dokument nahrál, potvrdil nebo smazal, název
            knihovny (vaše jméno, nebo název týmu) a záznam, že jste přijali pravidla Vlastních
            zdrojů,
          </li>
          <li>
            <strong>členství v týmu</strong> - název týmu, vaše role a pozvánky; vede je Clerk a já
            z něj jen zjišťuji, ke kterým knihovnám máte přístup.
          </li>
        </ul>
        <p>
          Účty a týmy vede poskytovatel přihlášení Clerk; drží e-mailovou adresu, identifikátor
          účtu, jméno, pokud ho vyplníte, a u týmů jejich členy, role a pozvánky. Přihlásíte-li se
          přes účet jiné služby (např. Google), předá do Clerku zpravidla totéž. Pozve-li vás do
          týmu jeho správce, zadá vaši e-mailovou adresu on a Clerk vám pošle pozvánku. Žádné další
          údaje z vašeho účtu nezpracovávám a hesla u sebe neuchovávám.
        </p>
        <p>
          Vaši konverzaci s AI asistentem server nevidí - nedostává ji. Dostane jen strojové
          volání, které asistent provede. Obsah rešerší v oficiálních zdrojích - dotazy a odpovědi
          - si trvale neukládám; trvale ukládám jen to, co sami nahrajete do Vlastních zdrojů.
          Reklamu nemám, údaje neprodávám a nepředávám je pro marketing. Nic o vás automaticky
          nevyhodnocuji ani neprofiluji.
        </p>
      </Section>

      <Section heading="3. Účel zpracování">
        <ul>
          <li>umožnění přihlášení a přístupu ke službě,</li>
          <li>udržení přihlašovací relace,</li>
          <li>vyřízení rešerše; krátká mezipaměť šetří zdroje, ze kterých se čerpá,</li>
          <li>
            u Vlastních zdrojů uložení vašich dokumentů, jejich zpracování do vyhledávacího indexu,
            návrh metadat, hledání a čtení v nich vaším asistentem a v týmu jejich sdílení s
            ostatními členy,
          </li>
          <li>přehled o tom, jak se služba používá, a její další zlepšování,</li>
          <li>
            provoz a bezpečnost služby, hlídání limitů, díky kterým může běžet zdarma, a prevence
            jejího zneužití.
          </li>
        </ul>
      </Section>

      <Section heading="4. Právní základ zpracování">
        <p>
          Účet, přihlašovací relaci a vyřízení rešerše včetně krátké dočasné paměti zpracovávám pro
          plnění smlouvy (čl. 6 odst. 1 písm. b) GDPR). Stejně tak Vlastní zdroje: uložení a
          zpracování dokumentů, jejich zpřístupnění vám a vašemu týmu, návrh metadat, členství v
          týmu a záznamy o tom, kdo co nahrál. Skutečnost, že je služba bezúplatná, na tom nic
          nemění.
        </p>
        <p>
          Údaje o používání služby, provozní záznamy hostingu a zprávy, které mi napíšete,
          zpracovávám na základě oprávněného zájmu (čl. 6 odst. 1 písm. f) GDPR) na tom, aby služba
          dobře fungovala, byla bezpečná a abych vyřídil, s čím se na mě obracíte.
        </p>
        <p>
          Na osobní údaje v nahraných dokumentech se tento bod nevztahuje. Právní základ k nim musí
          mít ten, kdo je nahrál, protože je jejich správcem (bod 1).
        </p>
      </Section>

      <Section heading="5. Doba uchování">
        <ul>
          <li>údaje o účtu - dokud účet trvá,</li>
          <li>přihlašovací relace - do svého vypršení,</li>
          <li>dočasná paměť - vyhledávání nejdéle 5 minut, texty rozhodnutí a předpisů nejdéle 10 minut,</li>
          <li>údaje o používání služby - nejdéle 12 měsíců,</li>
          <li>provozní záznamy hostingu - krátkodobě, v řádu dnů až týdnů,</li>
          <li>e-mailová korespondence - po dobu potřebnou k vyřízení věci, nejdéle rok.</li>
        </ul>
        <p>U Vlastních zdrojů platí:</p>
        <ul>
          <li>
            dokumenty (text, index a metadata) - dokud je nesmažete vy nebo správce týmu. Smazaný
            dokument zmizí hned; jen v historii změn, kterou Neon drží pro obnovu databáze po
            havárii, vydrží nejdéle 6 hodin,
          </li>
          <li>
            po zrušení účtu nebo týmu - knihovnu i s dokumenty smažu automaticky, nejpozději do 8
            dnů. Co jste nahráli do týmu, patří týmu a zůstává v něm i po vašem odchodu; smazat to
            může správce týmu,
          </li>
          <li>
            po odebrání režimu Pro - asistent v knihovně přestane hledat, ale ještě 90 dní ji
            uvidíte na webu, můžete dokumenty mazat a na požádání vám pošlu jejich text a metadata.
            Pak knihovnu smažu; předem vám o tom napíšu,
          </li>
          <li>
            text poslaný k návrhu metadat (bod 6) - Vercel ho smaže hned po vyřízení požadavku,
          </li>
          <li>
            záznamy o tom, kdo co v knihovně nahrál, potvrdil nebo smazal - dokud knihovna trvá,
          </li>
          <li>záznam o přijetí pravidel Vlastních zdrojů - dokud trvá účet.</li>
        </ul>
        <p>
          O smazání účtu a všech souvisejících údajů můžete požádat na <Mail />. Provedu je bez
          zbytečného odkladu.
        </p>
      </Section>

      <Section heading="6. Sdílení údajů s třetími stranami">
        <p>
          Vaše osobní údaje nepředávám nikomu k jeho vlastním účelům a neprodávám je. Na provozu se
          podílejí tři zpracovatelé, se kterými mám uzavřenou smlouvu o zpracování osobních údajů:
        </p>
        <ul>
          <li>
            <strong>Clerk, Inc.</strong> - přihlašování a správa účtů a týmů; společnost sídlí v
            USA a účty vede tam,
          </li>
          <li>
            <strong>Vercel, Inc.</strong> - hosting serveru; server běží v evropském regionu
            (Frankfurt), platforma americké společnosti je ale přístupná z USA. Přes svou službu AI
            Gateway mi Vercel také zprostředkuje jazykový model pro návrh metadat (viz níže),
          </li>
          <li>
            <strong>Neon, Inc.</strong> (skupina Databricks) - databáze Vlastních zdrojů; data leží
            v evropském regionu (Frankfurt), společnost je ale americká.
          </li>
        </ul>
        <p>
          Všichni tři si k plnění své role přibírají vlastní dodavatele (infrastruktura datových
          center, služba pro odesílání ověřovacích e-mailů), které váže stejná povinnost
          mlčenlivosti a stejná pravidla. U návrhu metadat je takovým dodavatelem Vercelu{" "}
          <strong>Google</strong>: když nahrajete dokument, pošlu přes AI Gateway jeho úvodní
          strany, tiráž, osnovu nadpisů a záhlaví stran (dohromady nejvýš asi 16 000 znaků) a
          název souboru, u PDF i s údaji z jeho vlastností, jazykovému modelu Gemini. Model z toho
          jen navrhne název, autory, rok a podobné údaje, které pak sami zkontrolujete. Vercel ani
          Google text nepoužijí k trénování modelů a Vercel ho po vyřízení požadavku smaže.
        </p>
        <p>
          Dokumenty v osobní knihovně vidíte jen vy. Dokumenty v týmové knihovně vidí všichni
          členové týmu, a to i s tím, kdo je nahrál; správce týmu navíc vidí seznam členů s jejich
          e-maily. Co si z vašich dokumentů přečte váš AI asistent, dostane i jeho poskytovatel
          (např. Anthropic nebo OpenAI) podle smlouvy, kterou s ním máte vy - to je vaše volba, ne
          předání z mé strany.
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
          Rešerše v oficiálních zdrojích Evropskou unii neopouští. Server běží v evropském regionu
          (Frankfurt) a databáze, do kterých se dotazuje, jsou české a unijní. Totéž platí pro
          Vlastní zdroje: text dokumentů, index i hledání v nich zůstávají v databázi ve
          Frankfurtu.
        </p>
        <p>Mimo Evropskou unii jde z mé strany jen tohle:</p>
        <ul>
          <li>údaje o vašem účtu a týmech, které Clerk vede ve Spojených státech,</li>
          <li>přístup k platformám Vercel a Neon, spravovaným rovněž odtamtud,</li>
          <li>
            část textu dokumentu k návrhu metadat (bod 6), kterou může Google zpracovat v USA.
          </li>
        </ul>
        <p>
          Předávání se opírá o rozhodnutí Evropské komise o odpovídající ochraně pro EU-US Data
          Privacy Framework, případně o standardní smluvní doložky ve smlouvách o zpracování.
          Clerk, Vercel i Google jsou v rámci Data Privacy Framework zapsány.
        </p>
      </Section>

      <Section heading="8. Cookies">
        <p>
          Kvůli přihlášení nastavuje na těchto stránkách poskytovatel přihlášení Clerk cookies{" "}
          <code>__session</code>, <code>__client_uat</code> a několik souvisejících (jejich
          varianty s příponou a krátkodobé cookies pro obnovení relace). Bez nich by přihlášení
          nefungovalo, jsou tedy nezbytné a souhlas k nim nepotřebuji. Další cookies nutné k
          udržení přihlášení nastavuje Clerk na své vlastní adrese.
        </p>
        <p>Analytické, reklamní ani jiné sledovací cookies nepoužívám.</p>
      </Section>

      <Section heading="9. Zabezpečení a umístění dat">
        <p>
          Server i databáze Vlastních zdrojů běží v evropském regionu (Frankfurt). Komunikace
          probíhá výhradně přes šifrované spojení (HTTPS) a server odmítá neověřené požadavky.
        </p>
        <p>
          U rešerší v oficiálních zdrojích chrání nejvíc to, co tu není: jejich obsah neukládám. Co
          projde dočasnou pamětí, po minutách mizí a s vaším účtem to spojené není.
        </p>
        <p>Vlastní zdroje chrání tři věci:</p>
        <ul>
          <li>
            <strong>originály sem vůbec nepřijdou</strong> - převádějí se na text ve vašem
            prohlížeči a server dostane jen ten text,
          </li>
          <li>
            <strong>každá knihovna je oddělená</strong> - osobní i týmová. Oddělení hlídá sama
            databáze pravidly zabezpečení na úrovni řádků (row-level security): každý dotaz vidí
            jen řádky knihoven, ke kterým má přihlášený uživatel přístup,
          </li>
          <li>
            <strong>přístup jen přes vaše přihlášení</strong> - k dokumentům se dostanete jen se
            svým účtem, ne přes starší sdílený přístupový kód, a to, ke kterým knihovnám máte
            přístup, průběžně ověřuji u Clerku.
          </li>
        </ul>
        <p>
          Kromě mě mají k údajům přístup jen poskytovatelé uvedení výše a jejich dodavatelé, a to v
          rozsahu nutném k tomu, aby služba běžela; k týmovým dokumentům navíc členové týmu. Do
          obsahu vašich dokumentů se nedívám, ledaže mě o to požádáte (třeba kvůli chybě převodu)
          nebo to vyžaduje oznámení nezákonného obsahu či zákon.
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
        <ul>
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
        <p>
          Týká-li se vás dokument, který sem nahrál někdo jiný, je správcem on (bod 1). Napíšete-li
          mi, žádost mu předám a pomohu mu ji vyřídit.
        </p>
      </Section>

      <Section heading="12. Změny těchto zásad">
        <p>
          Zásady mohu upravit, změní-li se fungování služby nebo právní úprava. Aktuální znění je
          vždy na této stránce a o podstatné změně vás budu informovat e-mailem.
        </p>
      </Section>
    </article>
  );
}
