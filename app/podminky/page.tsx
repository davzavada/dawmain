import Link from "next/link";
import { LegalHeader, Mail, Section } from "../_legal";

export const metadata = {
  title: "Podmínky užití - Dawmain",
  description:
    "Dawmain je zdarma a nekomerčně. Co to znamená, co od služby čekat a jaká pravidla platí pro Vlastní zdroje.",
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

      <Section heading="Vlastní zdroje (Pro)">
        <p>
          V režimu Pro si na webu nahrajete vlastní dokumenty - knihy, články, komentáře nebo vzory
          - a váš asistent v nich pak hledá vedle oficiálních databází. Pro je zdarma a přiděluji ho
          ručně, jednotlivcům i týmům; stačí mi napsat na <Mail />. Můžu ho kdykoli odebrat. Pokud
          nejde o porušení těchto pravidel, zůstane vám knihovna ještě 90 dní k prohlížení, mazání a
          stažení textu (podrobnosti v{" "}
          <Link href="/soukromi">Zásadách ochrany osobních údajů</Link>). Nahráním dokumentu
          potvrzujete, že pravidla v tomto oddílu dodržíte - web na ně upozorňuje přímo u nahrávání.
        </p>
        <p>
          <strong>Kvóty.</strong> Místo se počítá ve stranách: jedna strana je 3 600 znaků
          převedeného textu včetně poznámek pod čarou. Kolik stran dokument zabere a kolik vám
          zbývá, uvidíte před nahráním. Kvóty můžu podle kapacity měnit, už nahrané dokumenty kvůli
          tomu ale nemažu. Když se blíží limity bezplatných služeb, na kterých Vlastní zdroje běží,
          přepnou se samy do režimu jen pro čtení (hledat, číst a mazat jde, nahrávat ne), případně
          se na čas vypnou.
        </p>
        <p>
          <strong>Co sem smíte nahrát.</strong> Vlastní díla a poznámky, veřejné materiály
          (předpisy, rozhodnutí soudů a úřadů, texty s otevřenou licencí) a další texty, které máte
          právo si takto uložit a v týmu sdílet s ostatními členy. Nahráním potvrzujete, že tato
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
          <strong>AI a citace.</strong> Název, autory a další metadata navrhne jazykový model podle
          začátku dokumentu a asistent v dokumentu hledá hned po zpracování. Návrh se může
          splést: v detailu dokumentu ho kdykoli opravíte. Převod na text i čísla stran, poznámek a marginálních čísel dělá automat
          a může se splést. Vlastní dokument není oficiální zdroj - citace z něj si před použitím
          ověřte v tištěném vydání nebo v oficiálním textu.
        </p>
        <p>
          <strong>Záloha není.</strong> Originály si nechte u sebe: server je nikdy nedostane, takže
          vám je ani nemůže vrátit. Uložený text a metadata mimo krátkou historii změn databáze
          nezálohuji a za jejich ztrátu, třeba při výpadku nebo ukončení služby, neručím. Text
          svých dokumentů si ale můžete stáhnout tlačítkem „Exportovat text“ v detailu
          dokumentu (s denním limitem).
        </p>
        <p>
          <strong>Týmy.</strong> Tým založím na požádání a jeho správce si pak sám zve a odebírá
          členy. Nahrávat smějí všichni členové; každý upravuje, maže a stahuje své dokumenty,
          správce všechny. Co kdo do týmu nahraje, vidí celý tým a zůstává to v týmu i po jeho
          odchodu. Za to, kdo v týmu je a co se v něm sdílí, odpovídá správce týmu a tým, za který
          vystupuje.
        </p>
        <p>
          <strong>Osobní údaje v dokumentech.</strong> U osobních údajů v tom, co nahrajete, jste
          správcem vy a já zpracovatelem (čl. 28 GDPR); tento oddíl je naší smlouvou o zpracování.
          Zpracovávám je jen podle vašich pokynů - uložím je, zaindexuji a zpřístupním vašemu
          asistentovi a týmu - a k ničemu jinému je nepoužiji. Zachovám o nich mlčenlivost a
          chráním je, jak popisují Zásady ochrany osobních údajů. Tam je i seznam zpracovatelů,
          kterým je svěřuji (Vercel a přes něj Google, Neon); přibrání dalšího vám oznámím e-mailem
          aspoň měsíc předem, a když nebudete souhlasit, můžete Vlastní zdroje opustit. Pomůžu vám
          vyřídit žádosti lidí, o kterých dokumenty jsou, i s dalšími povinnostmi správce, o
          porušení zabezpečení vám dám vědět bez zbytečného odkladu a na požádání vám doložím, jak
          s údaji zacházím. Když Vlastní zdroje skončí, údaje smažu tak, jak uvádějí Zásady.
        </p>
        <p>
          <strong>Nezákonný obsah.</strong> Máte-li za to, že je ve Vlastních zdrojích nezákonný
          obsah (typicky porušení autorských práv), napište mi na <Mail />: o jaký dokument jde,
          proč je podle vás nezákonný, a své jméno a e-mail. Oznámení posoudím bez zbytečného
          odkladu. Nezákonný obsah nebo obsah v rozporu s těmito pravidly můžu odstranit, zabránit
          jeho opětovnému nahrání a přístup k Vlastním zdrojům omezit nebo zrušit. Tomu, koho se
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
