import Link from "next/link";
import type { ReactNode } from "react";
import { LegalHeader, Mail, Section } from "../_legal";

export const metadata = {
  title: "Zásady ochrany osobních údajů - Dawmain",
  description: "Jaké osobní údaje Dawmain zpracovává, proč, jak dlouho a jaká máte práva.",
};

/** One processing activity: what, why and on what basis, how long (čl. 13 GDPR). */
function Activity({
  heading,
  data,
  why,
  keep,
}: {
  heading: string;
  data: ReactNode;
  why: ReactNode;
  keep: ReactNode;
}) {
  return (
    <div className="legal-activity">
      <h3>{heading}</h3>
      <ul>
        <li>
          <strong>Údaje:</strong> {data}
        </li>
        <li>
          <strong>Proč:</strong> {why}
        </li>
        <li>
          <strong>Jak dlouho:</strong> {keep}
        </li>
      </ul>
    </div>
  );
}

const CONTRACT = "plnění smlouvy (čl. 6 odst. 1 písm. b) GDPR)";
const INTEREST = "oprávněný zájem (čl. 6 odst. 1 písm. f) GDPR)";

export default function Soukromi() {
  return (
    <article className="legal">
      <LegalHeader title="Zásady ochrany osobních údajů" />

      <Section heading="1. Správce">
        <p>
          <strong>David Závada</strong>, fyzická osoba; službu provozuji mimo rámec podnikání.
          Kontakt: <Mail />. Pověřence pro ochranu osobních údajů jmenovat nemusím a nejmenoval
          jsem ho.
        </p>
      </Section>

      <Section heading="2. Co zpracovávám, proč a jak dlouho">
        <Activity
          heading="Účet a přihlášení"
          data="e-mail, identifikátor účtu, jméno (pokud ho vyplníte) a přihlašovací relace. Účty vede Clerk; hesla u sebe neuchovávám."
          why={`přihlášení a přístup ke službě - ${CONTRACT}. Bezúplatnost služby na tom nic nemění.`}
          keep="dokud účet trvá; relace do svého vypršení."
        />
        <Activity
          heading="Rešerše v oficiálních zdrojích"
          data="strojová volání nástrojů a odpovědi zdrojů v dočasné paměti serveru, bez vazby na váš účet. Vaši konverzaci s AI asistentem server nedostává, jen volání, které asistent provede."
          why={`vyřízení dotazu; mezipaměť šetří veřejné zdroje - ${CONTRACT}.`}
          keep="vyhledávání nejdéle 5 minut, texty rozhodnutí a předpisů nejdéle 10 minut. Trvale nic neukládám."
        />
        <Activity
          heading="Vlastní soubory (Pro)"
          data={
            <>
              text nahraných dokumentů (převádí se ve vašem prohlížeči, původní soubor vaše
              zařízení neopustí), metadata (název, autoři, rok, typ, název a velikost souboru),
              vyhledávací index, záznam o tom, kdy jste dokument nahráli, upravili, stáhli nebo
              smazali, přijetí pravidel a denní počítadla pro limity.
            </>
          }
          why={`uložení dokumentů, hledání a čtení v nich vaším asistentem a návrh metadat (bod 3) - ${CONTRACT}. Záznam o výmazu knihovny uchovávám na základě ${INTEREST}, abych výmaz mohl doložit.`}
          keep={
            <>
              dokumenty, dokud je nesmažete (v historii změn databáze pro obnovu po havárii
              nejdéle 6 hodin); text dokumentu, který se nepodařilo zpracovat - 7 dní; denní
              počítadla čtení a stažení - 2 dny, ostatní počítadla nejdéle 12 měsíců. Po odebrání
              Pro ještě 90 dní ji uvidíte na webu, můžete dokumenty mazat a jejich text s metadaty
              si stáhnout („Stáhnout text“ u dokumentu v seznamu souborů); pak knihovnu smažu a
              předem vám o tom napíšu. Po zrušení účtu ji smažu nejpozději do 8 dnů. Po výmazu
              zůstane jen její interní označení a záznam, kdy a kolik dokumentů jsem vymazal.
            </>
          }
        />
        <Activity
          heading="Zotero (Pro)"
          data={
            <>
              klíč k vaší knihovně Zotero - ukládám ho zašifrovaný u vašeho účtu v Clerku, spolu s
              uživatelským jménem a identifikátorem v Zoteru, datem připojení a vaší volbou („Jen
              číst“, nebo „Číst a ukládat“). Dále obsah knihovny, na který se váš asistent zeptá
              (záznamy, poznámky, anotace, text příloh). Nemá-li Zotero text přílohy, stáhnu na
              dotaz asistenta PDF přílohu z úložiště Zotera a převedu ji na text. Nové záznamy, které
              asistent uloží, posílám rovnou do vaší knihovny.
            </>
          }
          why={`hledání a čtení ve vaší knihovně a při volbě „Číst a ukládat“ ukládání nových záznamů - ${CONTRACT}.`}
          keep={
            <>
              klíč, dokud Zotero neodpojíte nebo nezrušíte účet (v Zoteru zůstane, dokud ho
              nesmažete na zotero.org/settings/keys). Obsah knihovny jen v dočasné paměti nejdéle 10
              minut. Stažené PDF neukládám vůbec, zahodím ho hned po převodu.
            </>
          }
        />
        <Activity
          heading="Provoz a bezpečnost"
          data="údaje o používání (která volání server odbaví, kolik jich je, jak dopadnou) a provozní záznamy hostingu (IP adresa, čas, požadavek, chyby)."
          why={`provoz, bezpečnost, limity bezplatného provozu a zlepšování služby - ${INTEREST}.`}
          keep="údaje o používání nejdéle 12 měsíců, záznamy hostingu dny až týdny."
        />
        <Activity
          heading="Když mi napíšete"
          data="e-mail a obsah zprávy."
          why={`vyřízení vaší věci - ${INTEREST}.`}
          keep="do vyřízení, nejdéle rok."
        />
        <p>
          Reklamu nemám, údaje neprodávám a nic o vás automaticky nevyhodnocuji ani neprofiluji. Do
          Vlastních souborů nepatří neveřejné osobní údaje (<Link href="/podminky">Podmínky
          užití</Link>); objeví-li se v nahraném dokumentu přesto údaje o vás, napište mi a smažu
          ho.
        </p>
      </Section>

      <Section heading="3. Komu údaje svěřuji">
        <p>Na provozu se podílejí tři zpracovatelé, se kterými mám smlouvu o zpracování:</p>
        <ul>
          <li>
            <strong>Clerk, Inc.</strong> - přihlašování a účty (USA),
          </li>
          <li>
            <strong>Vercel, Inc.</strong> - hosting (server ve Frankfurtu) a přes AI Gateway
            jazykový model pro návrh metadat,
          </li>
          <li>
            <strong>Neon, Inc.</strong> - databáze Vlastních souborů (Frankfurt).
          </li>
        </ul>
        <p>
          K návrhu metadat posílám přes AI Gateway modelu Gemini (Google, dodavatel Vercelu) úvod
          dokumentu, osnovu a záhlaví stran (nejvýš asi 16 000 znaků) a název souboru. Text se
          nepoužije k trénování a Vercel ho po vyřízení smaže. Místo vašeho účtu AI Gateway dostane jen
          pseudonym.
        </p>
        <p>Mimo zpracovatele:</p>
        <ul>
          <li>
            co si asistent přečte, dostane i <strong>poskytovatel vašeho AI asistenta</strong>{" "}
            (např. Anthropic, OpenAI) podle vaší smlouvy s ním,
          </li>
          <li>
            <strong>Zotero</strong> není můj zpracovatel, ale vaše služba; posílám do ní jen to, co
            si váš asistent vyžádá,
          </li>
          <li>
            přihlášení účtem jiné služby (např. Google) - ta je samostatným správcem,
          </li>
          <li>
            veřejné databáze (e-Sbírka, soudy, EUR-Lex, InfoCuria, katalog UKAŽ) dostanou jen
            samotný dotaz, ne to, kdo jste,
          </li>
          <li>úřady a soudy jen tehdy, uloží-li mi to zákon.</li>
        </ul>
      </Section>

      <Section heading="4. Předávání mimo EU">
        <p>
          Rešerše v oficiálních zdrojích Evropskou unii neopouští a Vlastní soubory leží ve
          Frankfurtu. Mimo EU jdou jen údaje o účtu (Clerk, USA), správcovský přístup k platformám
          Vercel a Neon z USA a část textu dokumentu k návrhu metadat, kterou může Google zpracovat
          v USA. Clerk, Vercel, Neon i Google jsou zapsány v EU-US Data Privacy Framework (rozhodnutí
          Komise o odpovídající ochraně); záložně platí standardní smluvní doložky. Do Zotera (USA)
          posílám údaje jen na váš pokyn, protože je to nutné pro připojení, které jste si vybrali
          (čl. 49 odst. 1 písm. b) GDPR).
        </p>
      </Section>

      <Section heading="5. Cookies">
        <p>
          Clerk nastavuje kvůli přihlášení cookies <code>__session</code>, <code>__client_uat</code>{" "}
          a několik souvisejících; bez nich přihlášení nefunguje, jsou tedy nezbytné a souhlas k
          nim nepotřebuji. Při připojování Zotera nastavím na nejvýš 10 minut ještě nezbytnou cookie{" "}
          <code>dz_zotero_oauth</code>. Analytické ani reklamní cookies nepoužívám.
        </p>
      </Section>

      <Section heading="6. Zabezpečení">
        <ul>
          <li>vše jde přes HTTPS a server odmítá neověřené požadavky,</li>
          <li>
            u Vlastních souborů originály sem vůbec nepřijdou, jen text; každá knihovna je oddělená
            pravidly databáze (row-level security) a přístup je jen s vaším účtem,
          </li>
          <li>
            klíč k Zoteru šifruji (AES-256-GCM); o právo zápisu si Dawmain řekne jen při volbě
            „Číst a ukládat“, a to jen do vaší osobní knihovny, a i pak jen přidává - stávající
            nikdy nemění ani nemaže. Zvolíte-li „Jen číst“, nic nezapíše,
          </li>
          <li>
            Na rozdíl od Vlastních souborů sem u Zotera originály přijít mohou (PDF bez textu), ale
            jen do paměti po dobu převodu.
          </li>
        </ul>
      </Section>

      <Section heading="7. Vaše práva">
        <p>
          Máte právo na přístup ke svým údajům, jejich opravu, výmaz, omezení zpracování a
          přenositelnost (text a metadata dokumentů si stáhnete i sami). Proti zpracování na základě
          oprávněného zájmu můžete vznést námitku. Souhlas nikde nepotřebuji, takže není co odvolat.
          Napište na <Mail /> - vyřídím to zdarma do měsíce (u složité žádosti nejvýš o dva měsíce
          později, o čemž vám dám vědět). Stížnost můžete podat u Úřadu pro ochranu osobních údajů,
          Pplk. Sochora 27, 170 00 Praha 7, <a href="https://uoou.gov.cz">uoou.gov.cz</a>.
        </p>
      </Section>

      <Section heading="8. Změny">
        <p>
          Aktuální znění je vždy zde; o podstatné změně vás budu informovat e-mailem.
        </p>
      </Section>
    </article>
  );
}
