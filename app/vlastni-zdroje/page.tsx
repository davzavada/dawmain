import { redirect } from "next/navigation";

/**
 * The old address of Vlastní zdroje. The files are the /soubory page now;
 * keep links in e-mails, the texts and bookmarks working.
 */
export default function OwnSourcesRedirect(): never {
  redirect("/soubory");
}
