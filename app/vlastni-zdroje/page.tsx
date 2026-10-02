import { redirect } from "next/navigation";

/**
 * The old address of Vlastní zdroje. The files now live in a modal over the
 * current page (app/_zdroje/files-modal.tsx); keep links in e-mails, the
 * texts and bookmarks working by opening it on the home page.
 */
export default function OwnSourcesRedirect(): never {
  redirect("/?soubory=1");
}
