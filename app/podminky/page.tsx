import { TermsPage } from "../_legal-pages";
import { siteTexts } from "@/src/content/store";

export const metadata = {
  title: "Podmínky užití - Dawmain",
  description:
    "Dawmain je zdarma a nekomerčně. Co to znamená, co od služby čekat a jaká pravidla platí pro Vlastní soubory a Zotero.",
};

/** Static: the texts are read at build and after an admin saves them (never per visit). */
export default async function Podminky() {
  return <TermsPage texts={await siteTexts()} />;
}
