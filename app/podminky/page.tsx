import Link from "next/link";
import { LegalHeader, Mail, Section } from "../_legal";

export const metadata = {
  title: "Podmínky užití - Dawmain",
  description:
    "Dawmain je zdarma a nekomerčně. Co to znamená, co od služby čekat a jaká pravidla platí pro Vlastní soubory a Zotero.",
};

export default function Podminky() {
  return (
    <article className="legal">
      <LegalHeader title="Podmínky užití" />

      <p>
        Dawmain provozuji zdarma a ve volném čase jako nekomerční projekt. Napsat mi můžete na{" "}
        <Mail />. Smlouva mezi námi vzniká založením uživatelského účtu, a připojíte-li se starším
        sdíleným přístupovým kódem, prvním použitím služby. Tak jako tak je bezúplatná.
      </p>

      <Section heading="Účet a slušné užívání">
        <p>
          Používejte prosím svůj vlastní účet a nepůjčujte ho dál. Za to, co se pod ním děje, včetně
          volání vašeho asistenta, odpovídáte vy. Služba je na běžné rešerše. Nedělejte z ní prosím
          hromadné stahování databází - zdroje jsou cizí a jejich přetížení odnesou všichni ostatní.
          Když by někdo provoz ohrožoval, můžu jeho přístup dočasně omezit; ozvu se mu a domluvíme
          se.
        </p>
        <p>
          Snažím se, aby server šlapal, ale dostupnost nezaručuji - výpadky zdrojů jsou úplně mimo
          mou kontrolu. Jak na tom databáze zrovna jsou, ukazují kontrolky na{" "}
          <Link href="/#zdroje">hlavní stránce</Link>.
        </p>
        <p>
          Za správnost, úplnost ani aktuálnost obsahu ze zdrojů neručím, stejně jako za to, co z
          nich vyvodí váš AI asistent, nebo za rozhodnutí udělaná bez ověření v primárním zdroji.
          Službu dostáváte zdarma a takovou, jaká je.
        </p>
      </Section>

      <Section heading="Vlastní soubory (Pro)">
        <p>
          V režimu Pro si na webu nahrajete vlastní dokumenty - knihy, články, komentáře nebo vzory
          - a váš asistent v nich pak hledá vedle oficiálních databází. Pro je zdarma a přiděluji ho
          ručně; stačí mi napsat na <Mail />. Můžu ho kdykoli odebrat; vaši knihovnu pak do týdne smažu, takže si text svých
          dokumentů včas stáhněte. Nahráním dokumentu
          potvrzujete, že pravidla v tomto oddílu dodržíte - web na ně upozorňuje přímo u nahrávání.
        </p>
        <p>
          <strong>Kvóty.</strong> Místo se počítá ve stranách: jedna strana je 3 600 znaků
          převedeného textu včetně poznámek pod čarou. Kolik stran dokument zabere a kolik vám
          zbývá, uvidíte před nahráním. Kvóty můžu podle kapacity měnit, už nahrané dokumenty kvůli
          tomu ale nemažu. Když se blíží limity bezplatných služeb, na kterých Vlastní soubory běží,
          přepnou se samy do režimu jen pro čtení (hledat, číst a mazat jde, nahrávat ne), případně
          se na čas vypnou.
        </p>
        <p>
          <strong>Co sem smíte nahrát.</strong> Vlastní díla a poznámky, veřejné materiály
          (předpisy, rozhodnutí soudů a úřadů, texty s otevřenou licencí) a další texty, které máte
          právo si takto uložit. Nahráním potvrzujete, že tato
          práva máte. Pozor hlavně na licencované databáze: podmínky beck-online, ASPI, Codexis a
          podobných služeb obvykle zakazují budovat si z jejich obsahu vlastní databázi. A výjimka
          pro osobní potřebu (§ 30 autorského zákona) se na práci pro klienty, kancelář nebo firmu
          nevztahuje.
        </p>
        <p>
          <strong>Co sem nepatří:</strong>
        </p>
        <ul>
          <li>spisy a dokumenty klientů,</li>
          <li>osobní údaje, které nejsou veřejné,</li>
          <li>
            zvláštní kategorie osobních údajů a údaje o rozsudcích v trestních věcech a trestných
            činech (čl. 9 a 10 GDPR),
          </li>
          <li>obchodní tajemství jiných,</li>
          <li>cokoli nezákonného.</li>
        </ul>
        <p>
          Vzory nahrávejte bez osobních údajů klientů - vzor z konkrétní věci nejdřív anonymizujte.
        </p>
        <p>
          <strong>AI a citace.</strong> Typ dokumentu (komentář, článek, kniha…), název, autory a
          další metadata navrhne jazykový model podle začátku dokumentu a asistent v dokumentu hledá
          hned po zpracování. Návrh se může splést: po rozkliknutí dokumentu v seznamu souborů ho
          kdykoli opravíte. Převod na text i čísla stran, poznámek a marginálních čísel dělá automat
          a může se splést. Vlastní dokument není oficiální zdroj - citace z něj si před použitím
          ověřte v tištěném vydání nebo v oficiálním textu.
        </p>
        <p>
          <strong>Záloha není.</strong> Originály si nechte u sebe: server je nikdy nedostane, takže
          vám je ani nemůže vrátit. Uložený text a metadata mimo krátkou historii změn databáze
          nezálohuji a za jejich ztrátu, třeba při výpadku nebo ukončení služby, neručím. Text
          svých dokumentů si ale můžete stáhnout odkazem „Stáhnout text“ u dokumentu v seznamu
          souborů (s denním limitem).
        </p>
        <p>
          <strong>Osobní údaje.</strong> Jak s nimi zacházím, popisují{" "}
          <Link href="/soukromi">Zásady ochrany osobních údajů</Link>. Požádá-li mě někdo o výmaz
          údajů o sobě z nahraného dokumentu, dokument smažu a dám vám vědět.
        </p>
        <p>
          <strong>Nezákonný obsah.</strong> Máte-li za to, že je ve Vlastních souborech nezákonný
          obsah (typicky porušení autorských práv), napište mi na <Mail />: o jaký dokument jde,
          proč je podle vás nezákonný, a své jméno a e-mail. Oznámení posoudím bez zbytečného
          odkladu. Nezákonný obsah nebo obsah v rozporu s těmito pravidly můžu odstranit, zabránit
          jeho opětovnému nahrání a přístup k Vlastním souborům omezit nebo zrušit. Tomu, koho se
          to týká, napíšu, co jsem udělal a proč, a může se proti tomu ohradit.
        </p>
        <p>
          <strong>Kontaktní místo.</strong> Jednotným kontaktním místem pro orgány členských států,
          Evropskou komisi a Evropský sbor pro digitální služby (čl. 11 nařízení (EU) 2022/2065, akt
          o digitálních službách) i pro vás jako uživatele (čl. 12) je e-mail <Mail />. Psát na něj
          můžete česky nebo anglicky; odpovídám osobně, ne automat.
        </p>
        <p>
          <strong>Žádosti úřadů.</strong> Požádá-li o údaje nebo dokumenty soud, policie či jiný
          orgán, vyhovím jen tak, jak to ukládá zákon, a jen v nezbytném rozsahu. Dám vám o tom
          vědět, pokud mi to zákon nezakazuje. U dokumentů advokátů budu trvat na postupu, který
          zákon předepisuje k ochraně advokátního tajemství (§ 85b trestního řádu).
        </p>
      </Section>

      <Section heading="Zotero (Pro)">
        <p>
          V režimu Pro si můžete k Dawmainu připojit svou knihovnu v Zoteru (zotero.org). Váš
          asistent v ní pak hledá a čte záznamy, poznámky, anotace a text příloh, včetně skupin,
          kterých jste v Zoteru členem. Při připojení si vyberete, jestli Dawmain smí knihovnu{" "}
          <strong>jen číst</strong>, nebo <strong>číst a ukládat</strong>: pak asistent může
          nalezené dokumenty uložit do vaší osobní knihovny jako nové záznamy. Stávající záznamy
          Dawmain nikdy nemění ani nemaže a do skupin nezapisuje.
        </p>
        <p>
          Připojíte ji v nabídce účtu (položka Zotero): zvolíte „Jen číst“, nebo „Číst a ukládat“,
          a tlačítkem „Připojit Zotero“ přejdete na zotero.org. Zotero vás tam požádá o souhlas s
          klíčem v rozsahu podle vaší volby; rozsah tam můžete i zúžit. Volbu změníte tak, že Zotero
          připojíte znovu. Odpojit můžete kdykoli tamtéž tlačítkem „Odpojit“, nebo klíč smazat
          přímo v nastavení Zotera.
        </p>
        <p>
          Text příloh beru z indexu Zotera. Když tam chybí nebo je neúplný, převedu PDF přílohu na
          text sám. Převod dělá automat a může se splést, takže citace si ověřte v originálu. PDF
          uložená mimo úložiště Zotera (WebDAV, odkazované soubory) přečíst nejde.
        </p>
        <p>
          Zotero se řídí vlastními podmínkami. Za jeho dostupnost ani za obsah vaší knihovny
          neručím. Obsah knihovny nikam neukládám, projde jen dočasnou pamětí serveru.
        </p>
      </Section>

      <Section heading="Ukončení a změny">
        <p>
          Účet můžete kdykoli zrušit - napište na <Mail />. Já můžu provoz ukončit okamžitě.
        </p>
        <p>
          Podmínky můžu přiměřeně změnit, když se změní fungování služby nebo právní úprava. Nové
          znění dám sem a o důležité změně napíšu e-mailem s měsíčním předstihem. Když se vám změna
          nelíbí, můžete kdykoli do jejího účinku odejít; když zůstanete, platí, že vám nevadí.
        </p>
      </Section>

      <div className="signoff">
        <p>Díky a ať to šlape :)</p>
        <p className="muted">David Závada</p>
      </div>
    </article>
  );
}
