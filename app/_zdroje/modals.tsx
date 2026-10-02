"use client";

import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { UUID_RE } from "@/src/files/config";
import { FILES_PARAM, setFilesOpen } from "./store";

/**
 * The Vlastní soubory modal and the Zotero modal, mounted once in the root
 * layout and driven by the URL: ?soubory=1 (+ &dokument=<id> for the row
 * opened in the list; ?zdroje=… is the old name and still opens it),
 * ?zotero=1 (+ &stav=<outcome> when the connect flow comes back). Deep
 * links and the old /vlastni-zdroje route (which redirects here) open
 * them; closing removes the parameter. At most one shows: files first.
 *
 * Only this reader is in every page's bundle: the modals themselves — the
 * list, the uploader with the DMD parser — load when a parameter asks for
 * them, never for a visitor who does not open one.
 */

/** While a modal's code loads: the dimmed backdrop, so the click visibly did something. */
function Loading() {
  return (
    <div className="zd-layer" aria-busy="true">
      <div className="zd-backdrop" />
    </div>
  );
}

const FilesModal = dynamic(() => import("./files-modal").then((m) => m.FilesModal), { ssr: false, loading: Loading });
const ZoteroModal = dynamic(() => import("./zotero-modal").then((m) => m.ZoteroModal), { ssr: false, loading: Loading });

export function ZdrojeModals() {
  const params = useSearchParams();
  const files = params.get(FILES_PARAM) ?? params.get("zdroje");
  const doc = params.get("dokument");
  const zotero = params.get("zotero");
  const open = files !== null && files !== "";
  useEffect(() => setFilesOpen(open), [open]);
  return (
    <>
      {open ? <FilesModal documentId={doc && UUID_RE.test(doc) ? doc.toLowerCase() : null} /> : null}
      {zotero !== null && !open ? <ZoteroModal stav={params.get("stav")} /> : null}
    </>
  );
}
