import { LegalHeader, Mail, Section, list } from "../_legal";

export const metadata = {
  title: "Zásady ochrany osobních údajů - Dawmain",
  description: "Jaké osobní údaje Dawmain zpracovává, proč, jak dlouho a jaká máte práva.",
};

export default function Soukromi() {
  return (
    <>
      <LegalHeader title="Zásady ochrany osobních údajů" />

      <p>
        Dawmain je nekomerční projekt jednotlivce. Zpracovávám jen to, bez čeho by přihlášení a
        provoz serveru nefungovaly — nic navíc, nic na prodej. Tady je všechno, co se s vašimi údaji
        děje.
      </p>

      <Section heading="Kdo je zpracovává">
        <p>
          <strong>David Závada</strong>, fyzická osoba, provozující službu mimo podnikání. Ve všem,
          co se týče vašich údajů, se obracejte na <Mail /> — vyřizuji to sám, pověřence pro ochranu
          osobních údajů služba mít nemusí a nemá.
        </p>
      </Section>

      <Section heading="Co o vás vím">
        <p>
          <strong>Údaje o účtu</strong> — přihlášení zajišťuje poskytovatel Clerk:
        </p>
        <ul style={list}>
          <li>e-mailová adresa — abych vás rozlišil od ostatních a mohl vám případně napsat,</li>
          <li>
            jméno a profilová fotografie, pokud je předá způsob přihlášení, který jste zvolili
            (třeba účet Google) — jen aby se zobrazily v rozhraní; fotka se načítá přímo od
            poskytovatele a u mě se neukládá,
          </li>
          <li>identifikátor vašeho účtu u poskytovatele přihlášení,</li>
          <li>čas a technické údaje přihlášení, aby vydrželo.</li>
        </ul>
        <p>
          <strong>Přehled využití</strong> — počet volání po měsících a datum toho prvního. Je to
          kvůli vašemu přehledu na stránce <a href="/ucet">Správa účtu</a> a kvůli mému přehledu o
          zátěži serveru. Ukládá se <em>jenom počet</em>, ne to, co jste hledali.
        </p>
        <p>
          <strong>Provozní údaje</strong> — server běží na hostingu Vercel, který o požadavcích
          standardně vede technický záznam (IP adresa, čas, typ požadavku, chybová hlášení). Slouží
          k provozu a bezpečnosti.
        </p>
      </Section>

      <Section heading="Co o vás naopak nevím">
        <p>
          <strong>Obsah vašich dotazů se nikam neukládá.</strong> Server žádnou vlastní databázi
          nemá: dotaz jím projde do veřejné databáze, odpověď se vrátí a nejdéle deset minut může
          zůstat v dočasné paměti serveru — bez jakékoli vazby na váš účet. Neuchovávám hesla
          (přihlášení řeší poskytovatel), nemám tu žádnou analytiku ani reklamní nástroje, údaje
          neprodávám a nepředávám je pro marketing. Nic o vás automaticky nevyhodnocuji ani
          neprofiluji a nezpracovávám citlivé údaje jako zdravotní stav nebo názory.
        </p>
      </Section>

      <Section heading="Proč to zpracovávám">
        <ul style={list}>
          <li>
            <strong>Abyste mohli službu používat</strong> — bez účtu a přihlášení to nejde; je to
            plnění toho, na čem jsme se přihlášením dohodli.
          </li>
          <li>
            <strong>Aby služba fungovala a nikdo ji nezneužil</strong> — provozní záznamy a přehled
            o zátěži. Tady jde o můj oprávněný zájem na tom, aby server běžel.
          </li>
          <li>
            <strong>Abych vám odpověděl</strong>, když mi napíšete.
          </li>
        </ul>
        <p>
          Proti zpracování, které stojí na mém oprávněném zájmu, můžete kdykoli vznést námitku na{" "}
          <Mail />.
        </p>
      </Section>

      <Section heading="Kdo další se k nim dostane">
        <p>Jen dva poskytovatelé, kteří pro mě službu technicky provozují:</p>
        <ul style={list}>
          <li>
            <strong>Clerk, Inc.</strong> (USA) — přihlašování a účty,
          </li>
          <li>
            <strong>Vercel, Inc.</strong> (USA) — hosting serveru.
          </li>
        </ul>
        <p>
          S oběma mám uzavřenou smlouvu o zpracování osobních údajů a přenos do USA je krytý
          zárukami, které evropská pravidla vyžadují — buď rozhodnutím Evropské komise o odpovídající
          ochraně, nebo standardními smluvními doložkami. Podrobnosti vám na požádání pošlu. Nikomu
          jinému údaje nepředávám; jedinou výjimkou by byla povinnost uložená zákonem.
        </p>
        <p>
          Vaše dotazy server posílá do veřejných databází (e-Sbírka, Nejvyšší soud, Nejvyšší správní
          soud, Ústavní soud, rozhodnuti.justice.cz, InfoCuria, EUR-Lex). Putuje k nim jen samotný
          dotaz, nikoli to, kdo jste. Tyto instituce si své údaje spravují samy podle svých pravidel.
        </p>
      </Section>

      <Section heading="Cookies">
        <p>
          Jen ty technicky nezbytné, které udrží vaše přihlášení (od poskytovatele Clerk), chráněné
          příznaky Secure, HttpOnly a SameSite. Právě proto, že bez nich by přihlášení nefungovalo,
          se na ně souhlas nevyžaduje. Žádné analytické ani reklamní cookies tu nejsou.
        </p>
      </Section>

      <Section heading="Jak dlouho si je nechávám">
        <ul style={list}>
          <li>údaje o účtu — dokud účet trvá,</li>
          <li>přihlášení — než relace vyprší,</li>
          <li>přehled využití — posledních dvanáct měsíců, starší se odmazávají,</li>
          <li>provozní záznamy hostingu — krátce, v řádu dnů až týdnů.</li>
        </ul>
        <p>
          Když si řeknete o zrušení účtu na <Mail />, smažu všechno bez zbytečného odkladu.
        </p>
      </Section>

      <Section heading="Zabezpečení">
        <p>
          Komunikace jede výhradně po šifrovaném spojení (HTTPS). K datům se dostanu jen já a
          poskytovatelé zmínění výše. Server odmítá neověřené požadavky a hesla u sebe vůbec nemám.
        </p>
      </Section>

      <Section heading="Co s tím můžete dělat vy">
        <p>Kdykoli máte právo:</p>
        <ul style={list}>
          <li>vědět, co o vás vedu, a dostat kopii,</li>
          <li>nechat si opravit nepřesnosti,</li>
          <li>nechat údaje smazat,</li>
          <li>omezit, co s nimi dělám,</li>
          <li>dostat je ve strojově čitelné podobě a vzít si je jinam,</li>
          <li>vznést námitku proti zpracování z oprávněného zájmu.</li>
        </ul>
        <p>
          Stačí napsat na <Mail />; ozvu se bez zbytečného odkladu, nejpozději do měsíce. Když se
          vám můj postup nebude zdát, můžete si stěžovat u dozorového úřadu:{" "}
          <strong>Úřad pro ochranu osobních údajů</strong>, Pplk. Sochora 27, 170 00 Praha 7,{" "}
          <a href="https://uoou.gov.cz">uoou.gov.cz</a>.
        </p>
      </Section>

      <Section heading="Změny">
        <p>
          Když se fungování služby změní, upravím i tuhle stránku a o důležité změně dám vědět
          e-mailem. Poslední aktualizace: 28. 8. 2026.
        </p>
      </Section>
    </>
  );
}
