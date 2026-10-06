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
          <strong>David Závada</strong>, fyzická osoba
          <br />
          E-mail: <Mail />
        </p>
      </Section>

      <Section heading="2. Jaké údaje zpracovávám">
        <ul>
          <li>
            <strong>Údaje o účtu</strong> - e-mailová adresa, jméno a identifikátor účtu (při
            přihlášení účtem Google je předá Google).
          </li>
          <li>
            <strong>Provozní záznamy a přehled o používání</strong> - čas požadavku, volaný
            nástroj, výsledek a IP adresa; počty volání u účtu, ze kterých vidím, kdo službu
            používá, jak často a které nástroje.
          </li>
          <li>
            <strong>Vlastní soubory (Pro)</strong> - text dokumentů, které nahrajete, jejich
            metadata (název, autoři, rok, typ, název souboru) a záznam o tom, kdy jste je
            nahráli, upravili, stáhli nebo smazali. Dokumenty mohou obsahovat i osobní údaje
            jiných lidí, například jména autorů.
          </li>
          <li>
            <strong>Zotero (Pro)</strong> - zašifrovaný klíč k vaší knihovně a vaše uživatelské
            jméno a identifikátor v Zoteru.
          </li>
        </ul>
        <p>
          Údaje o účtu jsou pro poskytování služby nezbytné; bez nich účet nelze vytvořit.
          Provozní záznamy vznikají automaticky při každém použití služby. Nahrávání dokumentů a
          připojení Zotera jsou dobrovolné. Obsah rešerší si neukládám a s vaším účtem ho
          nespojuji.
        </p>
      </Section>

      <Section heading="3. Účel a právní základ">
        <ul>
          <li>
            <strong>plnění smlouvy</strong> (čl. 6 odst. 1 písm. b) GDPR): vedení účtu, přihlášení,
            Vlastní soubory včetně návrhu metadat (bod 5) a připojení Zotera;
          </li>
          <li>
            <strong>oprávněný zájem</strong> (čl. 6 odst. 1 písm. f) GDPR): provozní záznamy,
            hlídání limitů, ochrana služby před zneužitím, záznam o provedeném výmazu a přehled o
            tom, kdo a jak službu používá, abych ji mohl rozvíjet. Přehled je jen pro mě, k
            marketingu ho nepoužívám, nikomu ho nedávám a nepoužívám žádné analytické nástroje
            třetích stran. Na oprávněném zájmu stojí i zpracování osobních údajů jiných lidí v
            nahraných dokumentech - jen v rozsahu potřebném k tomu, aby v nich váš asistent mohl
            hledat. Proti zpracování na základě oprávněného zájmu můžete vznést námitku.
          </li>
        </ul>
      </Section>

      <Section heading="4. Doba uchování">
        <ul>
          <li>Údaje o účtu - dokud účet trvá; o jeho smazání můžete kdykoli požádat e-mailem.</li>
          <li>
            Provozní záznamy hostingu (včetně IP adresy) - nejdéle 30 dní; počty volání u účtu
            nejdéle 12 měsíců.
          </li>
          <li>
            Vlastní soubory a záznamy o práci s nimi - dokud dokument nesmažete, nejdéle však do
            zrušení účtu nebo odebrání Pro. Pak knihovnu do týdne smažu (do té doby si po odebrání
            Pro můžete stáhnout text svých dokumentů). Smazaný dokument zůstane nejdéle 6 hodin v
            historii změn databáze pro obnovu po havárii. Po výmazu knihovny si ponechám jen
            záznam o výmazu (identifikátor knihovny, datum a počet smazaných dokumentů), dokud
            může být potřeba výmaz doložit.
          </li>
          <li>
            Klíč k Zoteru, uživatelské jméno a identifikátor - dokud Zotero neodpojíte nebo
            nezrušíte účet. Přestane-li klíč platit, smažu ho a do opětovného připojení,
            odpojení nebo zrušení účtu si ponechám jen uživatelské jméno a čas, kdy klíč přestal
            platit.
          </li>
        </ul>
      </Section>

      <Section heading="5. Komu údaje předávám">
        <p>Na provozu se podílejí tři zpracovatelé:</p>
        <ul>
          <li>
            <strong>Clerk, Inc.</strong> - přihlašování a správa účtů,
          </li>
          <li>
            <strong>Vercel, Inc.</strong> - hosting (Frankfurt) a služba AI Gateway, přes kterou
            využívám jazykový model Gemini od Google (viz níže),
          </li>
          <li>
            <strong>Neon, Inc.</strong> - databáze Vlastních souborů (Frankfurt).
          </li>
        </ul>
        <p>
          <strong>Návrh metadat přes Gemini.</strong> Po nahrání dokumentu pošlu přes AI Gateway
          modelu Gemini (Google, dodavatel Vercelu) výňatek z dokumentu, ne celý text: úvodní
          strany, tiráž, seznam autorů, osnovu nadpisů a záhlaví stran (dohromady nejvýš 16 000
          znaků), název souboru a u PDF údaje z jeho vlastností. Účelem je jen navrhnout typ
          dokumentu, název, autory, rok a podobné údaje, které pak můžete opravit. Právní základ
          je stejný jako u Vlastních souborů (bod 3). Výňatek může obsahovat osobní údaje lidí
          uvedených v dokumentu, typicky jména autorů. Vaše jméno ani e-mail s ním neposílám;
          AI Gateway dostane jen pseudonym kvůli rozpočtu spotřeby. Text se nepoužije k
          trénování modelů a Vercel ho po vyřízení požadavku smaže.
        </p>
        <p>
          Jde o americké společnosti; předávání do USA se opírá o EU-US Data Privacy Framework.
          Jinak údaje předám jen orgánům veřejné moci, ukládá-li mi to zákon. Přihlášení účtem
          Google se řídí{" "}
          <a href="https://policies.google.com/privacy">zásadami ochrany soukromí Google</a>.
        </p>
      </Section>

      <Section heading="6. Zabezpečení">
        <p>
          Komunikace probíhá výhradně přes HTTPS. Knihovny Vlastních souborů jsou v databázi od sebe
          oddělené a klíč k Zoteru je šifrovaný. Používám jen cookies nezbytné pro přihlášení,
          žádné analytické ani reklamní.
        </p>
      </Section>

      <Section heading="7. Vaše práva">
        <p>Máte právo:</p>
        <ul>
          <li>na přístup ke svým osobním údajům,</li>
          <li>na opravu nepřesných údajů,</li>
          <li>na výmaz údajů,</li>
          <li>na omezení zpracování a na přenositelnost údajů,</li>
          <li>vznést námitku proti zpracování na základě oprávněného zájmu,</li>
          <li>
            podat stížnost u Úřadu pro ochranu osobních údajů (
            <a href="https://uoou.gov.cz">uoou.gov.cz</a>).
          </li>
        </ul>
        <p>
          Pro uplatnění svých práv mě kontaktujte na <Mail />; odpovím do měsíce.
        </p>
      </Section>
    </article>
  );
}
