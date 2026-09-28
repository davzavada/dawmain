import { redirect } from "next/navigation";

/**
 * The old address of Vlastní zdroje. The library now lives in a modal over
 * the current page (app/_zdroje/sources-modal.tsx); keep links in e-mails,
 * the texts and bookmarks working by opening it on the home page.
 */
export default function OwnSourcesRedirect(): never {
  redirect("/?zdroje=moje");
}
