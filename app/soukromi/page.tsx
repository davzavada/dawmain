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
          <strong>David Závada</strong>, fyzická osoba (služba je provozována mimo podnikání)
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
            <strong>Provozní záznamy</strong> - čas požadavku, volaný nástroj, výsledek a IP adresa;
            počty volání pro hlídání limitů.
          </li>
          <li>
            <strong>Vlastní soubory (Pro)</strong> - dokumenty, které nahrajete, a záznam o tom,
            kdy jste je nahráli, upravili, stáhli nebo smazali.
          </li>
          <li>
            <strong>Zotero (Pro)</strong> - zašifrovaný klíč k vaší knihovně a vaše uživatelské
            jméno v Zoteru.
          </li>
        </ul>
        <p>Obsah rešerší si neukládám a s vaším účtem ho nespojuji.</p>
      </Section>

      <Section heading="3. Účel a právní základ">
        <ul>
          <li>
            <strong>plnění smlouvy</strong> (čl. 6 odst. 1 písm. b) GDPR): vedení účtu, přihlášení,
            Vlastní soubory a připojení Zotera;
          </li>
          <li>
            <strong>oprávněný zájem</strong> (čl. 6 odst. 1 písm. f) GDPR): provozní záznamy,
            hlídání limitů a ochrana služby před zneužitím; proti tomu můžete vznést námitku.
          </li>
        </ul>
      </Section>

      <Section heading="4. Doba uchování">
        <ul>
          <li>Údaje o účtu - dokud účet trvá; o jeho smazání můžete kdykoli požádat e-mailem.</li>
          <li>Provozní záznamy - dny až týdny; počty volání nejdéle 12 měsíců.</li>
          <li>
            Vlastní soubory - dokud je nesmažete; po zrušení účtu je smažu nejpozději do 8 dnů. Po
            odebrání Pro je ještě 90 dní uvidíte na webu a můžete si stáhnout jejich text.
          </li>
          <li>Klíč k Zoteru - dokud Zotero neodpojíte nebo nezrušíte účet.</li>
        </ul>
      </Section>

      <Section heading="5. Komu údaje předávám">
        <p>Na provozu se podílejí tři zpracovatelé:</p>
        <ul>
          <li>
            <strong>Clerk, Inc.</strong> - přihlašování a správa účtů,
          </li>
          <li>
            <strong>Vercel, Inc.</strong> - hosting (Frankfurt); přes AI Gateway také model Gemini
            od Google, který navrhuje metadata nahraných dokumentů (bez vazby na váš účet),
          </li>
          <li>
            <strong>Neon, Inc.</strong> - databáze Vlastních souborů (Frankfurt).
          </li>
        </ul>
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
          Pro uplatnění svých práv mě kontaktujte na <Mail />.
        </p>
      </Section>
    </article>
  );
}
