import Link from "next/link";
import type { ReactNode } from "react";
import { LegalHeader, Mail, Section } from "../_legal";

export const metadata = {
  title: "Zásady ochrany osobních údajů - Dawmain",
  description: "Jaké osobní údaje Dawmain zpracovává, proč, jak dlouho a jaká máte práva.",
};

/** One processing activity: what, why, on what basis, how long (čl. 13 GDPR). */
function Activity({
  heading,
  data,
  purpose,
  basis,
  retention,
  children,
}: {
  heading: string;
  data: ReactNode;
  purpose: ReactNode;
  basis: ReactNode;
  retention: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="legal-activity">
      <h3>{heading}</h3>
      <p>
        <strong>Údaje:</strong>
      </p>
      {data}
      <p>
        <strong>Účel:</strong> {purpose}
      </p>
      <p>
        <strong>Právní základ:</strong> {basis}
      </p>
      <p>
        <strong>Doba uchování:</strong>
      </p>
      {retention}
      {children}
    </div>
  );
}

const CONTRACT = "plnění smlouvy (čl. 6 odst. 1 písm. b) GDPR)";
const INTEREST = "oprávněný zájem (čl. 6 odst. 1 písm. f) GDPR)";

export default function Soukromi() {
  return (
    <article className="legal">
      <LegalHeader title="Zásady ochrany osobních údajů" />

      <Section heading="1. Kdo je správce">
        <p>
          <strong>David Závada</strong>, fyzická osoba; službu provozuji mimo rámec podnikání.
          Ve všech věcech osobních údajů mi pište na <Mail />.
        </p>
        <p>
          Správcem jsem u všech osobních údajů, které Dawmain zpracovává: o vás jako uživateli i o
          lidech zmíněných v dokumentech, které nahrajete do Vlastních souborů, nebo v knihovně
          Zotero, kterou k Dawmainu připojíte (bod 3). Jejich správcem jsem já, ne vy: co se s nimi
          v Dawmainu děje, jak dlouho tu jsou a komu je svěřuji, určuji já. Vy jen odpovídáte za
          to, že dokument smíte nahrát a že neobsahuje nic, co sem podle{" "}
          <Link href="/podminky">Podmínek užití</Link> nepatří.
        </p>
        <p>
          Pověřence pro ochranu osobních údajů jmenovat nemusím a nejmenoval jsem ho.
        </p>
      </Section>

      <Section heading="2. Co zpracovávám, proč, na jakém základě a jak dlouho">
        <p>
          Reklamu nemám, údaje neprodávám a nepředávám je pro marketing. Nic o vás automaticky
          nevyhodnocuji ani neprofiluji. Vaši konverzaci s AI asistentem server nevidí - nedostává
          ji. Dostane jen strojové volání, které asistent provede.
        </p>

        <Activity
          heading="Účet a přihlášení"
          data={
            <ul>
              <li>
                <strong>e-mailová adresa</strong>, <strong>identifikátor účtu</strong> a jméno,
                pokud ho vyplníte. Účty vede poskytovatel přihlášení Clerk. Přihlásíte-li se účtem
                jiné služby (např. Google), předá do Clerku zpravidla totéž. Hesla u sebe
                neuchovávám,
              </li>
              <li>
                <strong>přihlašovací relace</strong> (cookies, bod 6) a u účtu poznámka, zda máte
                režim Pro.
              </li>
            </ul>
          }
          purpose="přihlášení a přístup ke službě, rozlišení uživatelů a komunikace s vámi."
          basis={`${CONTRACT}. Skutečnost, že je služba bezúplatná, na tom nic nemění.`}
          retention={
            <ul>
              <li>údaje o účtu - dokud účet trvá,</li>
              <li>přihlašovací relace - do svého vypršení.</li>
            </ul>
          }
        />

        <Activity
          heading="Rešerše v oficiálních zdrojích"
          data={
            <ul>
              <li>
                <strong>strojová volání nástrojů a odpovědi zdrojů</strong> - krátce v dočasné
                paměti serveru, aby opakovaný dotaz nezatěžoval veřejné zdroje. S vaším účtem
                spojená nejsou.
              </li>
            </ul>
          }
          purpose="vyřízení dotazu vašeho asistenta; krátká mezipaměť šetří zdroje, ze kterých se čerpá."
          basis={`${CONTRACT}.`}
          retention={
            <ul>
              <li>
                dočasná paměť - vyhledávání nejdéle 5 minut, texty rozhodnutí a předpisů nejdéle 10
                minut. Obsah rešerší - dotazy a odpovědi - si trvale neukládám.
              </li>
            </ul>
          }
        />

        <Activity
          heading="Vlastní soubory (režim Pro)"
          data={
            <ul>
              <li>
                <strong>text nahraných dokumentů</strong> - dokumenty se na text převádějí přímo ve
                vašem prohlížeči; původní soubor vaše zařízení neopustí a na server jde jen
                převedený text,
              </li>
              <li>
                <strong>metadata dokumentů</strong> - název, autoři, rok, typ dokumentu a podobně,
                a také název a velikost původního souboru,
              </li>
              <li>
                <strong>vyhledávací index</strong> - z textu odvozená slova, strany, oddíly,
                poznámky a identifikátory (spisové značky, paragrafy), ve kterých asistent hledá,
              </li>
              <li>
                <strong>kdo co udělal</strong> - kdy jste dokument nahráli, upravili, stáhli nebo
                smazali, název knihovny a záznam, že jste přijali pravidla Vlastních souborů,
              </li>
              <li>
                <strong>denní počítadla</strong> - kolik jste za den v dokumentech četli a kolik
                jste si z nich stáhli; hlídají limity, díky kterým může služba běžet zdarma.
              </li>
            </ul>
          }
          purpose="uložení vašich dokumentů, jejich zpracování do vyhledávacího indexu, návrh typu dokumentu a metadat (bod 4), hledání a čtení v nich vaším asistentem a doložení, co se s knihovnou dělo."
          basis={`${CONTRACT}. Záznam o tom, že jsem knihovnu vymazal, uchovávám na základě ${INTEREST} - abych mohl doložit, že jsem výmaz provedl. K osobním údajům třetích osob v dokumentech viz bod 3.`}
          retention={
            <ul>
              <li>
                dokumenty (text, index a metadata) - dokud je nesmažete. Smazaný dokument zmizí
                hned; jen v historii změn, kterou Neon drží pro obnovu databáze po havárii,
                vydrží nejdéle 6 hodin,
              </li>
              <li>
                text dokumentu, který se nepodařilo zpracovat - 7 dní, abych ho mohl zkusit
                zpracovat znovu. Pak ho smažu; v seznamu zůstane jen záznam o chybě, dokud ho
                nesmažete,
              </li>
              <li>
                text poslaný k návrhu metadat (bod 4) - Vercel ho smaže hned po vyřízení požadavku,
              </li>
              <li>
                záznamy o tom, co jste v knihovně nahráli, upravili, stáhli nebo smazali - dokud
                knihovna trvá. Po jejím výmazu zůstane jen její interní označení a záznam, kdy a
                kolik dokumentů jsem vymazal, bez jména a bez obsahu,
              </li>
              <li>
                denní počítadla čtení a stažení - 2 dny; ostatní počítadla knihovny (nahrání,
                strany, spotřeba) nejdéle 12 měsíců,
              </li>
              <li>záznam o přijetí pravidel Vlastních souborů - dokud trvá účet,</li>
              <li>
                po odebrání režimu Pro - asistent v knihovně přestane hledat, ale ještě 90 dní ji
                uvidíte na webu, můžete dokumenty mazat a jejich text s metadaty si stáhnout (odkaz
                „Stáhnout text“ u dokumentu v seznamu souborů; kdyby to nešlo, napište mi a pomůžu
                vám). Pak knihovnu smažu; předem vám o tom napíšu,
              </li>
              <li>
                po zrušení účtu - knihovnu i s dokumenty smažu automaticky, nejpozději do 8 dnů.
              </li>
            </ul>
          }
        />

        <Activity
          heading="Zotero (režim Pro)"
          data={
            <ul>
              <li>
                <strong>klíč k vaší knihovně Zotero</strong> - vydá ho Zotero, když připojení na
                jeho stránce potvrdíte. Ukládám ho zašifrovaný u vašeho účtu v Clerku, spolu s
                vaším uživatelským jménem a číselným identifikátorem v Zoteru, datem připojení,
                vaší volbou („Jen číst“, nebo „Číst a ukládat“) a tím, k čemu klíč opravňuje
                (čtení knihovny, poznámek a skupin, případně zápis do vaší osobní knihovny),
              </li>
              <li>
                <strong>obsah knihovny, na který se váš asistent zeptá</strong> - záznamy (název,
                autoři, další údaje, štítky, kolekce), poznámky, anotace a text příloh. Neukládám
                ho, projde jen dočasnou pamětí. Nemá-li Zotero text přílohy zaindexovaný, stáhnu na
                dotaz asistenta PDF přílohu z úložiště Zotera, převedu ji na text a soubor hned
                zahodím,
              </li>
              <li>
                <strong>záznamy, které asistent uloží</strong> - zvolíte-li „Číst a ukládat“, pošlu
                na pokyn asistenta do vaší knihovny nový záznam (typ, název, autoři, datum, odkaz
                na zdroj a podobně). U sebe ho neuchovávám; žije ve vaší knihovně v Zoteru.
              </li>
            </ul>
          }
          purpose="připojení vaší knihovny, hledání a čtení v ní vaším asistentem a při volbě „Číst a ukládat“ ukládání nových záznamů do ní."
          basis={`${CONTRACT}. K osobním údajům třetích osob v knihovně viz bod 3.`}
          retention={
            <ul>
              <li>
                klíč a údaje o připojení - dokud Zotero neodpojíte nebo nezrušíte účet. Odpojením
                klíč smažu a požádám Zotero, aby ho zrušilo. Přestane-li klíč platit (třeba když ho
                smažete v Zoteru), smažu ho také a do dalšího připojení si nechám jen vaše
                uživatelské jméno v Zoteru a čas, kdy klíč přestal platit,
              </li>
              <li>
                po zrušení účtu klíč smažu spolu s účtem; v Zoteru ale zůstane, dokud ho nesmažete
                v jeho nastavení (zotero.org/settings/keys),
              </li>
              <li>
                obsah knihovny - jen v dočasné paměti: seznamy skupin a kolekcí, údaje k hledání
                podle spisové značky a texty příloh nejdéle 10 minut. Stažené PDF neukládám vůbec,
                zahodím ho hned po převodu na text,
              </li>
              <li>
                záznamy, které asistent do Zotera uložil - zůstávají ve vaší knihovně, dokud je tam
                nesmažete; u sebe je neuchovávám.
              </li>
            </ul>
          }
        />

        <Activity
          heading="Provoz, bezpečnost a statistiky"
          data={
            <ul>
              <li>
                <strong>údaje o používání služby</strong> - která volání server odbaví, kolik jich
                je a jak dopadnou,
              </li>
              <li>
                <strong>provozní záznamy hostingu</strong> - IP adresa, čas, typ požadavku, chybová
                hlášení.
              </li>
            </ul>
          }
          purpose="provoz a bezpečnost služby, hlídání limitů, díky kterým může běžet zdarma, prevence zneužití a přehled o tom, jak se služba používá, abych ji mohl zlepšovat."
          basis={`${INTEREST} na tom, aby služba dobře fungovala a byla bezpečná.`}
          retention={
            <ul>
              <li>údaje o používání služby - nejdéle 12 měsíců,</li>
              <li>provozní záznamy hostingu - krátkodobě, v řádu dnů až týdnů.</li>
            </ul>
          }
        />

        <Activity
          heading="Když mi napíšete"
          data={
            <ul>
              <li>vaše e-mailová adresa, obsah zprávy a moje odpověď.</li>
            </ul>
          }
          purpose="vyřízení toho, s čím se na mě obracíte (dotaz, žádost o Pro, uplatnění práv, oznámení nezákonného obsahu)."
          basis={`${INTEREST} na tom, abych vaši věc vyřídil; u žádosti o uplatnění práv splnění právní povinnosti (čl. 6 odst. 1 písm. c) GDPR).`}
          retention={
            <ul>
              <li>po dobu potřebnou k vyřízení věci, nejdéle rok.</li>
            </ul>
          }
        />
      </Section>

      <Section heading="3. Lidé zmínění v nahraných dokumentech a v knihovně Zotero">
        <p>
          Dokumenty, které uživatelé nahrají do Vlastních souborů, a záznamy v připojené knihovně
          Zotero mohou obsahovat osobní údaje dalších lidí - typicky jména autorů článků a knih,
          soudců, advokátů nebo účastníků v rozhodnutích. Tyto údaje nezískávám od vás, ale od
          uživatele, který dokument nahrál nebo knihovnu připojil.
        </p>
        <ul>
          <li>
            <strong>Účel:</strong> uložení dokumentu a hledání a čtení v něm asistentem
            uživatele, který ho nahrál - jen pro jeho vlastní rešerše. Dokumenty nikomu dalšímu
            nezpřístupňuji a k ničemu jinému je nepoužívám.
          </li>
          <li>
            <strong>Právní základ:</strong> {INTEREST} - můj a uživatelův zájem na tom, aby mohl
            ve svých podkladech k právní práci a studiu hledat. Jde převážně o údaje už veřejné
            (publikovaná rozhodnutí a literatura) a Podmínky užití nahrávat neveřejné osobní
            údaje, spisy klientů ani zvláštní kategorie údajů nedovolují.
          </li>
          <li>
            <strong>Doba uchování:</strong> stejně jako dokument, v němž jsou (bod 2).
          </li>
          <li>
            <strong>Příjemci a předávání:</strong> stejní zpracovatelé jako u Vlastních souborů a
            Zotera (body 4 a 5).
          </li>
        </ul>
        <p>
          Každého, kdo je v nahraných dokumentech zmíněn, jednotlivě informovat nemohu: nevím, kdo
          to je, a nemám na něj kontakt (čl. 14 odst. 5 písm. b) GDPR). Proto tyto zásady
          zveřejňuji. Týká-li se vás nějaký dokument, napište mi - vyhledám ho, a vznesete-li
          námitku nebo žádost o výmaz, dokument nebo jeho část smažu, ledaže by vážně převažoval
          zájem na jeho ponechání. Zjistím-li, že dokument obsahuje údaje, které sem nepatří,
          smažu ho i bez žádosti.
        </p>
      </Section>

      <Section heading="4. Komu údaje svěřuji">
        <p>
          Vaše osobní údaje nepředávám nikomu k jeho vlastním účelům a neprodávám je. Na provozu se
          podílejí tři zpracovatelé, se kterými mám uzavřenou smlouvu o zpracování osobních údajů:
        </p>
        <ul>
          <li>
            <strong>Clerk, Inc.</strong> - přihlašování a správa účtů; společnost sídlí v USA a
            účty vede tam,
          </li>
          <li>
            <strong>Vercel, Inc.</strong> - hosting serveru; server běží v evropském regionu
            (Frankfurt), platforma americké společnosti je ale přístupná z USA. Přes svou službu AI
            Gateway mi Vercel také zprostředkuje jazykový model pro návrh metadat (viz níže),
          </li>
          <li>
            <strong>Neon, Inc.</strong> (skupina Databricks) - databáze Vlastních souborů; data
            leží v evropském regionu (Frankfurt), společnost je ale americká.
          </li>
        </ul>
        <p>
          Všichni tři si k plnění své role přibírají vlastní dodavatele (infrastruktura datových
          center, služba pro odesílání ověřovacích e-mailů), které váže stejná povinnost
          mlčenlivosti a stejná pravidla. U návrhu metadat je takovým dodavatelem Vercelu{" "}
          <strong>Google</strong>: když nahrajete dokument, pošlu přes AI Gateway jeho úvodní
          strany, tiráž, osnovu nadpisů a záhlaví stran (dohromady nejvýš asi 16 000 znaků) a
          název souboru, u PDF i s údaji z jeho vlastností, jazykovému modelu Gemini. Model z toho
          jen navrhne typ dokumentu, název, autory, rok a podobné údaje, které pak sami můžete
          opravit. Vercel ani Google text nepoužijí k trénování modelů a Vercel ho po vyřízení
          požadavku smaže. Kdo dokument nahrál, s požadavkem neposílám: AI Gateway kvůli rozpočtu
          spotřeby dostane jen pseudonym, ze kterého se váš účet vyčíst nedá.
        </p>
        <p>Mimo moje zpracovatele se údaje dostanou jen sem:</p>
        <ul>
          <li>
            <strong>poskytovatel vašeho AI asistenta</strong> (např. Anthropic nebo OpenAI) - co si
            z oficiálních zdrojů, vašich dokumentů nebo knihovny Zotero asistent přečte, dostane i
            on, podle smlouvy, kterou s ním máte vy. Je to vaše volba, ne předání z mé strany,
          </li>
          <li>
            <strong>Zotero</strong> (Corporation for Digital Scholarship, USA) - není můj
            zpracovatel. Je to služba, kterou máte vy a kterou jste k Dawmainu sami připojili. Na
            pokyn vašeho asistenta do ní s vaším klíčem posílám jeho dotazy, načítám z ní záznamy a
            přílohy a při volbě „Číst a ukládat“ do ní zapisuji nové záznamy. Zotero vede vaši
            knihovnu podle svých{" "}
            <a href="https://www.zotero.org/support/privacy">zásad ochrany soukromí</a>,
          </li>
          <li>
            <strong>poskytovatel přihlášení účtem jiné služby</strong> (např. Google) - samostatný
            správce, ověří vaši totožnost sám za sebe a řídí se{" "}
            <a href="https://policies.google.com/privacy">vlastními zásadami ochrany soukromí</a>,
          </li>
          <li>
            <strong>veřejné databáze</strong> (e-Sbírka, Nejvyšší soud, Nejvyšší správní soud,
            Ústavní soud, rozhodnuti.justice.cz, InfoCuria, EUR-Lex) a knihovní katalog UKAŽ
            Univerzity Karlovy (Primo) - putuje do nich pouze samotný dotaz, nikoli to, kdo jste,
          </li>
          <li>
            <strong>soudy a úřady</strong> - jen tehdy, uloží-li mi to zákon, a jen v nezbytném
            rozsahu.
          </li>
        </ul>
      </Section>

      <Section heading="5. Předávání mimo Evropskou unii">
        <p>
          Rešerše v oficiálních zdrojích Evropskou unii neopouští. Server běží v evropském regionu
          (Frankfurt) a databáze, do kterých se dotazuje, jsou české a unijní. Totéž platí pro
          Vlastní soubory: text dokumentů, index i hledání v nich zůstávají v databázi ve
          Frankfurtu.
        </p>
        <p>Mimo Evropskou unii jde z mé strany jen tohle:</p>
        <ul>
          <li>údaje o vašem účtu, které Clerk vede ve Spojených státech,</li>
          <li>přístup k platformám Vercel a Neon, spravovaným rovněž odtamtud,</li>
          <li>
            část textu dokumentu k návrhu metadat (bod 4), kterou může Google zpracovat v USA.
          </li>
        </ul>
        <p>
          Předávání se opírá o rozhodnutí Evropské komise o odpovídající ochraně pro EU-US Data
          Privacy Framework, případně o standardní smluvní doložky ve smlouvách o zpracování.
          Clerk, Vercel i Google jsou v rámci Data Privacy Framework zapsány.
        </p>
        <p>
          Připojíte-li Zotero, putují dotazy vašeho asistenta, váš klíč a případně nové záznamy do
          Zotera, které data vede v USA. Děje se to jen na váš pokyn, do služby, kterou jste si sami
          vybrali a připojili, a je to nezbytné k tomu, abych vám připojení Zotera mohl poskytnout
          (čl. 49 odst. 1 písm. b) GDPR).
        </p>
      </Section>

      <Section heading="6. Cookies">
        <p>
          Kvůli přihlášení nastavuje na všech stránkách tohoto webu (v záhlaví je vidět, kdo je
          přihlášen) poskytovatel přihlášení Clerk cookies <code>__session</code>,{" "}
          <code>__client_uat</code> a několik souvisejících (jejich varianty s příponou a
          krátkodobé cookies pro obnovení relace). Bez nich by přihlášení nefungovalo, jsou tedy
          nezbytné a souhlas k nim nepotřebuji. Další cookies nutné k udržení přihlášení nastavuje
          Clerk na své vlastní adrese.
        </p>
        <p>
          Když připojujete Zotero, nastavím na nejvýš 10 minut ještě cookie{" "}
          <code>dz_zotero_oauth</code>. Spojí návrat ze stránky Zotera s vaším přihlášením a po
          dokončení připojení ji smažu. Je také nezbytná.
        </p>
        <p>Analytické, reklamní ani jiné sledovací cookies nepoužívám.</p>
      </Section>

      <Section heading="7. Zabezpečení">
        <p>
          Server i databáze Vlastních souborů běží v evropském regionu (Frankfurt). Komunikace
          probíhá výhradně přes šifrované spojení (HTTPS) a server odmítá neověřené požadavky.
        </p>
        <p>
          U rešerší v oficiálních zdrojích chrání nejvíc to, co tu není: jejich obsah neukládám. Co
          projde dočasnou pamětí, po minutách mizí a s vaším účtem to spojené není.
        </p>
        <p>Vlastní soubory chrání tři věci:</p>
        <ul>
          <li>
            <strong>originály sem vůbec nepřijdou</strong> - převádějí se na text ve vašem
            prohlížeči a server dostane jen ten text,
          </li>
          <li>
            <strong>každá knihovna je oddělená</strong> - oddělení hlídá sama databáze pravidly
            zabezpečení na úrovni řádků (row-level security): každý dotaz vidí jen řádky knihovny
            přihlášeného uživatele,
          </li>
          <li>
            <strong>přístup jen přes vaše přihlášení</strong> - k dokumentům se dostanete jen se
            svým účtem, ne přes starší sdílený přístupový kód, a to, zda máte režim Pro, průběžně
            ověřuji u Clerku.
          </li>
        </ul>
        <p>Připojení Zotera chrání:</p>
        <ul>
          <li>
            <strong>klíč jen v rozsahu vaší volby</strong> - o právo zápisu si Dawmain řekne jen
            při volbě „Číst a ukládat“, a to jen do vaší osobní knihovny. I pak jen přidává nové
            záznamy: stávající nikdy nemění ani nemaže. Zvolíte-li „Jen číst“, nic nezapíše, ani
            kdybyste zápis na stránce Zotera povolili,
          </li>
          <li>
            <strong>zašifrovaný klíč</strong> - šifruji ho (AES-256-GCM) klíčem, který je jen v
            nastavení serveru, takže ze samotného záznamu v Clerku ho nikdo nepřečte,
          </li>
          <li>
            <strong>přístup jen přes vaše přihlášení</strong> - stejně jako u Vlastních souborů jen
            s vaším účtem v režimu Pro, ne přes sdílený přístupový kód.
          </li>
        </ul>
        <p>
          Na rozdíl od Vlastních souborů sem u Zotera originály přijít mohou: nemá-li Zotero text
          přílohy, stáhnu PDF z jeho úložiště. Zůstane ale jen v paměti serveru po dobu převodu;
          na disk ani do databáze ho neukládám.
        </p>
        <p>
          Kromě mě mají k údajům přístup jen zpracovatelé uvedení v bodě 4 a jejich dodavatelé, a
          to v rozsahu nutném k tomu, aby služba běžela. Do obsahu vašich dokumentů se nedívám,
          ledaže mě o to požádáte (třeba kvůli chybě převodu), vyřizuji žádost člověka, kterého se
          dokument týká (bod 3), nebo to vyžaduje oznámení nezákonného obsahu či zákon.
        </p>
      </Section>

      <Section heading="8. Vaše práva">
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
            na vaši žádost pošlu přímo jinému správci, je-li to technicky proveditelné. Text a
            metadata svých dokumentů si z Vlastních souborů můžete stáhnout i sami odkazem
            „Stáhnout text“ u dokumentu v seznamu souborů.
          </li>
          <li>
            <strong>Právo vznést námitku.</strong> Proti zpracování, které stojí na oprávněném
            zájmu - údaje o používání služby, provozní záznamy, vaše zprávy a údaje o vás v
            dokumentech jiných uživatelů (bod 3) - můžete kdykoli vznést námitku. Údaje pak dál
            zpracovávat nebudu, ledaže prokážu závažné oprávněné důvody, které převažují nad vašimi
            zájmy, právy a svobodami.
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
      </Section>

      <Section heading="9. Změny těchto zásad">
        <p>
          Zásady mohu upravit, změní-li se fungování služby nebo právní úprava. Aktuální znění je
          vždy na této stránce a o podstatné změně vás budu informovat e-mailem.
        </p>
      </Section>
    </article>
  );
}
