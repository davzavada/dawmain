import { Suspense } from "react";
import { FilesPage } from "../files-page";

export const metadata = {
  title: "Vlastní soubory - Dawmain",
  description: "Vaše dokumenty a dokumenty vašich týmů, ve kterých asistent hledá vedle oficiálních databází.",
};

/**
 * /soubory (the personal library) and /soubory/<handle> (a team's). The
 * page is a static shell: which library, its folders and documents are
 * loaded by the browser for the signed-in user (app/soubory/files-page.tsx).
 */
export default function Soubory() {
  return (
    <Suspense fallback={null}>
      <FilesPage />
    </Suspense>
  );
}
