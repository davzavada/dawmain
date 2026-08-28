import { LegalHeader, Mail, Section } from "../_legal";

export const metadata = {
  title: "Zásady ochrany osobních údajů - Dawmain",
  description: "Jaké osobní údaje Dawmain zpracovává, proč, jak dlouho a jaká máte práva.",
};

const table: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "0.85rem",
  lineHeight: 1.5,
  marginTop: "0.6rem",
};

const cell: React.CSSProperties = {
  border: "1px solid #e5e7eb",
  padding: "0.45rem 0.6rem",
  verticalAlign: "top",
  textAlign: "left",
};

const head: React.CSSProperties = {
  ...cell,
  background: "#f9fafb",
  fontWeight: 600,
};

/** Tables get more columns than a phone has width; each scrolls by itself. */
function Scroll({ children }: { children: React.ReactNode }) {
  return <div style={{ overflowX: "auto" }}>{children}</div>;
}

export default function Soukromi() {
  return (
    <>
      <LegalHeader title="Zásady ochrany osobních údajů" />

      <p>
        Správcem je <strong>David Závada</strong>, kontakt <Mail />. Pověřence pro ochranu osobních
        údajů nemám a vzhledem k povaze a rozsahu zpracování ho mít nemusím.
      </p>
      <p>
        Vlastní databázi nevedu a nic si trvale neukládám. Reklamu nemám, údaje neprodávám a
        nepředávám je pro marketing. Nic o vás automaticky nevyhodnocuji ani neprofiluji.
      </p>

      <Section heading="1. Co zpracovávám, proč a jak dlouho">
        <Scroll>
          <table style={table}>
            <thead>
              <tr>
                <th style={head}>Údaj</th>
                <th style={head}>Účel</th>
                <th style={head}>Právní základ</th>
                <th style={head}>Doba uchování</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={cell}>E-mailová adresa a identifikátor účtu</td>
                <td style={cell}>Přihlášení, přístup ke službě, udržení relace</td>
                <td style={cell}>Plnění smlouvy — čl. 6 odst. 1 písm. b) GDPR</td>
                <td style={cell}>Dokud trvá účet; relace do svého vypršení</td>
              </tr>
              <tr>
                <td style={cell}>
                  Strojové volání nástroje a odpověď zdroje v dočasné paměti serveru
                </td>
                <td style={cell}>
                  Vyřízení rešerše; krátká mezipaměť šetří veřejné zdroje, ze kterých se čerpá
                </td>
                <td style={cell}>Plnění smlouvy — čl. 6 odst. 1 písm. b) GDPR</td>
                <td style={cell}>
                  Vyhledávání nejdéle 5 minut, texty rozhodnutí a předpisů nejdéle 10 minut
                </td>
              </tr>
              <tr>
                <td style={cell}>
                  Údaje o používání služby (která volání server odbaví, kolik jich je a jak
                  dopadnou)
                </td>
                <td style={cell}>
                  Přehled o tom, jak se služba používá, a její další zlepšování
                </td>
                <td style={cell}>Oprávněný zájem — čl. 6 odst. 1 písm. f) GDPR</td>
                <td style={cell}>Nejdéle 12 měsíců</td>
              </tr>
              <tr>
                <td style={cell}>
                  Provozní záznamy hostingu (IP adresa, čas, typ požadavku, chybová hlášení)
                </td>
                <td style={cell}>
                  Provoz a bezpečnost služby, dohledání příčiny výpadku, odhalení nepřiměřené
                  zátěže a pokusů o neoprávněný přístup
                </td>
                <td style={cell}>Oprávněný zájem — čl. 6 odst. 1 písm. f) GDPR</td>
                <td style={cell}>Krátkodobě, v řádu dnů až týdnů</td>
              </tr>
              <tr>
                <td style={cell}>E-mailová adresa a obsah zprávy, kterou mi napíšete</td>
                <td style={cell}>Vyřízení toho, s čím se na mě obracíte, a odpověď vám</td>
                <td style={cell}>Oprávněný zájem — čl. 6 odst. 1 písm. f) GDPR</td>
                <td style={cell}>Po dobu potřebnou k vyřízení věci, nejdéle rok</td>
              </tr>
            </tbody>
          </table>
        </Scroll>
        <p>
          <strong>Účet.</strong> Účty vede poskytovatel přihlášení Clerk; drží vaši e-mailovou
          adresu a identifikátor účtu. Přihlásíte-li se přes účet jiné služby, předá tento
          poskytovatel do Clerku zpravidla totéž. Můj vlastní server si o vás od Clerku nic
          nenačítá — z každého požadavku pozná jen to, že patří ověřenému účtu. Hesla u sebe
          neuchovávám.
        </p>
        <p>
          <strong>Co se k serveru vůbec dostane.</strong> Vaši konverzaci s AI asistentem nevidím —
          server ji nedostává. Dostane jen strojové volání, které asistent provede.
        </p>
      </Section>

      <Section heading="2. Komu se údaje dostanou">
        <Scroll>
          <table style={table}>
            <thead>
              <tr>
                <th style={head}>Příjemce</th>
                <th style={head}>Role</th>
                <th style={head}>Co se k němu dostane</th>
                <th style={head}>Kde</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={cell}>Clerk, Inc.</td>
                <td style={cell}>Můj zpracovatel — přihlašování a správa účtů</td>
                <td style={cell}>E-mailová adresa, identifikátor účtu</td>
                <td style={cell}>USA</td>
              </tr>
              <tr>
                <td style={cell}>Vercel, Inc.</td>
                <td style={cell}>Můj zpracovatel — hosting serveru</td>
                <td style={cell}>Provozní záznamy</td>
                <td style={cell}>
                  Server v evropském regionu (Frankfurt), platforma americké společnosti přístupná
                  z USA
                </td>
              </tr>
              <tr>
                <td style={cell}>
                  Poskytovatel přihlášení účtem jiné služby (např. Google)
                </td>
                <td style={cell}>
                  Samostatný správce — ověří vaši totožnost a předá mi e-mail a identifikátor
                </td>
                <td style={cell}>Řídí se jeho vlastními pravidly</td>
                <td style={cell}>Dle jeho pravidel</td>
              </tr>
            </tbody>
          </table>
        </Scroll>
        <p>
          S Clerkem i Vercelem mám uzavřenou smlouvu o zpracování osobních údajů. Oba si k plnění
          své role přibírají vlastní dodavatele (infrastruktura datových center, služba pro
          odesílání ověřovacích e-mailů), které váže stejná povinnost mlčenlivosti a stejná
          pravidla.
        </p>
        <p>
          Předání do Spojených států se opírá o rozhodnutí Evropské komise o odpovídající ochraně
          pro EU-US Data Privacy Framework; obě společnosti jsou v tomto rámci zapsány. Nikomu
          dalšímu údaje k jeho vlastním účelům nepředávám a neprodávám je. Údaje předám jen tehdy,
          uloží-li mi to zákon.
        </p>
      </Section>

      <Section heading="3. Cookies">
        <p>Tyto stránky nenastavují žádné cookies.</p>
        <p>
          Přihlašovací okno provozuje na své vlastní adrese Clerk a cookies nutné k udržení
          přihlášení nastavuje on.
        </p>
      </Section>

      <Section heading="4. Vaše práva">
        <p>
          Máte právo na přístup ke svým údajům a na jejich kopii, na opravu, na výmaz, na omezení
          zpracování a na přenositelnost. Uplatníte je na <Mail /> — zdarma a bez zbytečného
          odkladu, nejpozději do měsíce od doručení žádosti. Je-li žádost složitá, mohu lhůtu
          prodloužit až o další dva měsíce; do měsíce vám pak dám vědět, že ji prodlužuji a proč. O
          zrušení účtu a smazání všech souvisejících údajů požádejte tamtéž.
        </p>
        <p>
          <strong>Právo vznést námitku.</strong> Proti zpracování, které stojí na mém oprávněném
          zájmu, můžete kdykoli vznést námitku na <Mail />. Údaje pak dál zpracovávat nebudu,
          ledaže prokážu závažné oprávněné důvody, které převažují nad vašimi zájmy, právy a
          svobodami.
        </p>
        <p>
          Máte také právo podat stížnost u Úřadu pro ochranu osobních údajů, Pplk. Sochora 27, 170
          00 Praha 7, <a href="https://uoou.gov.cz">uoou.gov.cz</a>.
        </p>
      </Section>

      <Section heading="5. Zabezpečení">
        <p>
          Komunikace probíhá výhradně přes šifrované spojení (HTTPS), server odmítá neověřené
          požadavky a hesla u sebe neuchovávám. Kromě mě mají k údajům přístup jen poskytovatelé
          uvedení výše a jejich dodavatelé, a to v rozsahu nutném k tomu, aby služba běžela.
        </p>
      </Section>

      <Section heading="6. Změny těchto zásad">
        <p>
          Zásady mohu upravit, změní-li se fungování služby nebo právní úprava. Aktuální znění je
          vždy na této stránce a o podstatné změně vás budu informovat e-mailem.
        </p>
      </Section>
    </>
  );
}
