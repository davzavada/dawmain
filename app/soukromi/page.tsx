import { PrivacyPage } from "../_legal-pages";
import { siteTexts } from "@/src/content/store";

export const metadata = {
  title: "Zásady ochrany osobních údajů - Dawmain",
  description: "Jaké osobní údaje Dawmain zpracovává, proč, jak dlouho a jaká máte práva.",
};

/** Static: the texts are read at build and after an admin saves them (never per visit). */
export default async function Soukromi() {
  return <PrivacyPage texts={await siteTexts()} />;
}
