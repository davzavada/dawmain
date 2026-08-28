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
        <p>
          <strong>Údaje o účtu.</strong> Účty vede poskytovatel přihlášení Clerk. Drží vaši
          e-mailovou adresu, kterou vás rozlišuji od ostatních a na kterou vám mohu napsat, a
          identifikátor vašeho účtu. Přihlásíte-li se přes účet jiné služby, předá jí zvolený
          poskytovatel to, co s takovým přihlášením předává. Můj vlastní server si o vás od Clerku
          nic nenačítá; z každého požadavku pozná jen to, že patří ověřenému účtu.
        </p>
        <p>
          <strong>Připojení bez účtu.</strong> Server přijímá také starší sdílený přístupový kód.
          Kdo se připojí jím, nemá u mě žádný účet a kromě provozních záznamů níže o něm nevím nic.
        </p>
        <p>
          <strong>Provozní údaje.</strong> Server běží na hostingu, který o požadavcích vede
          standardní technický záznam: IP adresa, čas, typ požadavku a chybová hlášení. Slouží k
          provozu a bezpečnosti.
        </p>
        <p>
          <strong>Co se děje s vašimi dotazy.</strong> Vlastní databázi nemám a dotazy neukládám.
          Dotaz serverem projde do veřejné databáze a odpověď se vrátí. Aby opakovaný dotaz zbytečně
          nezatěžoval zdroje, drží server dotaz i odpověď krátce v dočasné paměti: výsledky
          vyhledávání nejdéle pět minut, texty rozhodnutí a předpisů nejdéle deset. Není to spojeno s
          vaším účtem, paměť o něm nic neví, a po uplynutí té doby záznam mizí. Nikam dál se
          neukládá.
        </p>
        <p>
          Neuchovávám hesla, protože přihlášení zajišťuje poskytovatel. Nemám žádné analytické ani
          reklamní nástroje, údaje neprodávám a nepředávám je pro marketing. Nic o vás automaticky
          nevyhodnocuji ani neprofiluji. Citlivé údaje, jako je zdravotní stav, náboženské vyznání
          nebo politické názory, cíleně nezpracovávám. Protože ale jde o právní rešerše, může je
          obsahovat text vašeho dotazu; pak serverem projdou a po tu krátkou dobu leží v dočasné
          paměti jako každý jiný dotaz. Zvažte prosím proto, co do dotazu píšete.
        </p>
      </Section>

      <Section heading="3. Účel zpracování">
        <ul style={list}>
          <li>umožnění přihlášení a přístupu ke službě,</li>
          <li>udržení přihlašovací relace,</li>
          <li>vyřízení dotazu, který mi pošlete e-mailem,</li>
          <li>zajištění provozu a bezpečnosti služby a prevence jejího zneužití.</li>
        </ul>
      </Section>

      <Section heading="4. Právní základ zpracování">
        <p>
          <strong>Účet.</strong> E-mailovou adresu a identifikátor účtu zpracovávám proto, abych vám
          mohl službu vůbec poskytnout, tedy pro splnění toho, na čem jsme se přihlášením dohodli.
          Skutečnost, že je služba bezúplatná, na tom nic nemění. Žádný zákon vám poskytnutí těchto
          údajů neukládá, ale bez e-mailové adresy nelze účet založit a přihlášení nefunguje. Nic
          jiného po vás nechci.
        </p>
        <p>
          <strong>Provoz a bezpečnost.</strong> Technické záznamy hostingu zpracovávám na základě
          svého oprávněného zájmu na tom, aby služba běžela a nebyla zneužita. Konkrétně mi slouží k
          tomu, abych dohledal příčinu výpadku nebo chyby, poznal nepřiměřenou zátěž, která by
          ohrozila provoz nebo zdroje, ze kterých se čerpá, a odhalil pokusy o neoprávněný přístup.
        </p>
        <p>
          <strong>Vaše zprávy.</strong> Napíšete-li mi, zpracuji vaši adresu a obsah zprávy, abych
          vám mohl odpovědět. Týká-li se zpráva vašeho účtu, je to součást naší dohody; jinak jde o
          můj oprávněný zájem na tom vyřídit, s čím se na mě obracíte.
        </p>
        <p>
          Proti zpracování, které stojí na oprávněném zájmu, můžete kdykoli vznést námitku na{" "}
          <Mail />.
        </p>
      </Section>

      <Section heading="5. Cookies">
        <p>
          Tyto stránky nenastavují žádné cookies. Ani samotné připojení AI asistenta ke službě na
          cookies nestojí, přístupový token cestuje v hlavičce požadavku.
        </p>
        <p>
          Přihlašovací okno provozuje na své vlastní adrese poskytovatel Clerk a cookies nutné k
          udržení přihlášení nastavuje on. Bez nich by přihlášení nefungovalo, proto se k nim souhlas
          nevyžaduje. Žádné analytické ani reklamní cookies ve hře nejsou.
        </p>
      </Section>

      <Section heading="6. Doba uchování">
        <ul style={list}>
          <li>údaje o účtu - dokud účet trvá,</li>
          <li>přihlašovací relace - do jejího vypršení,</li>
          <li>dotazy v dočasné paměti serveru - nejdéle pět minut u vyhledávání a deset u textů,</li>
          <li>provozní záznamy hostingu - krátkodobě, v řádu dnů až týdnů,</li>
          <li>e-mailová korespondence - po dobu, po kterou je potřeba k vyřízení věci, nejdéle rok.</li>
        </ul>
        <p>
          O zrušení účtu a smazání všech souvisejících údajů můžete požádat na <Mail />. Provedu je
          bez zbytečného odkladu.
        </p>
      </Section>

      <Section heading="7. Sdílení údajů s třetími stranami">
        <p>
          Vaše osobní údaje nepředávám nikomu k jeho vlastním účelům a neprodávám je. Na provozu
          služby se za mě podílejí dva poskytovatelé, se kterými mám uzavřenou smlouvu o zpracování
          osobních údajů:
        </p>
        <ul style={list}>
          <li>
            <strong>Clerk, Inc.</strong> - přihlašování a správa uživatelských účtů. Společnost sídlí
            ve Spojených státech a účty vede tam.
          </li>
          <li>
            <strong>Vercel, Inc.</strong> - hosting serveru. Server běží v evropském regionu ve
            Frankfurtu, provozovatelem je ale americká společnost, takže provozní záznamy jsou
            v její platformě a z USA přístupné.
          </li>
        </ul>
        <p>
          Oba poskytovatelé si k plnění své role přibírají vlastní dodavatele, například
          infrastrukturu datových center a službu pro odesílání ověřovacích e-mailů. Váže je stejná
          povinnost mlčenlivosti a stejná pravidla ochrany údajů.
        </p>
        <p>
          Obě společnosti jsou zapsány v rámci EU-US Data Privacy Framework, takže se předání do
          Spojených států opírá o rozhodnutí Evropské komise o odpovídající ochraně; smlouvy s nimi
          navíc obsahují vzorové doložky schválené Evropskou komisí, které se uplatní, kdyby toto
          rozhodnutí přestalo platit. O kopii těchto záruk si můžete napsat na <Mail />.
        </p>
        <p>
          Přihlásíte-li se přes účet jiné služby, například přes Google, rozhoduje tento poskytovatel
          o zpracování při ověření vaší totožnosti sám za sebe a řídí se vlastními pravidly. Není
          mým zpracovatelem.
        </p>
        <p>
          Vaše dotazy server odesílá do veřejných databází (e-Sbírka, Nejvyšší soud, Nejvyšší správní
          soud, Ústavní soud, rozhodnuti.justice.cz, InfoCuria, EUR-Lex). Putuje k nim pouze samotný
          dotaz, nikoli to, kdo jste. Tyto instituce jsou samostatnými správci a řídí se vlastními
          pravidly. Údaje dále předám jen tehdy, uloží-li mi to zákon.
        </p>
      </Section>

      <Section heading="8. Zabezpečení údajů">
        <p>
          Komunikace probíhá výhradně přes šifrované spojení (HTTPS). Server odmítá neověřené
          požadavky a hesla u sebe neuchovávám. Kromě mě mají k údajům přístup jen poskytovatelé
          uvedení výše a jejich dodavatelé, a to v rozsahu nutném k tomu, aby služba běžela.
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
          Pro uplatnění svých práv mě kontaktujte na <Mail />. Vyřídím je zdarma a bez zbytečného
          odkladu, nejpozději do měsíce od doručení žádosti. Kdyby byla žádost složitá, mohu tuto
          lhůtu prodloužit až o další dva měsíce; v takovém případě vám do měsíce dám vědět, že ji
          prodlužuji a proč.
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
