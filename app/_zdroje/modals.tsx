"use client";

import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { UUID_RE } from "@/src/files/config";
import { setSourcesOpen } from "./store";

/**
 * The Vlastní zdroje modal (design 2b–2e), the team modal (3d, 3f) and the
 * Zotero modal, mounted once in the root layout and driven by the URL:
 * ?zdroje=moje|tym (+ &dokument=<id> for a document's detail), ?tym=<org id>,
 * ?zotero=1 (+ &stav=<outcome> when the connect flow comes back). Deep links
 * and the old /vlastni-zdroje route (which redirects here) open them; closing
 * removes the parameter. At most one shows: sources, then team, then Zotero.
 * (Zotero has its own parameter: ?zdroje=zotero would read as the "moje" tab.)
 *
 * Only this reader is in every page's bundle: the modals themselves — the
 * list, the detail, the uploader with the DMD parser — load when a
 * parameter asks for them, never for a visitor who does not open one.
 */

/** While a modal's code loads: the dimmed backdrop, so the click visibly did something. */
function Loading() {
  return (
    <div className="zd-layer" aria-busy="true">
      <div className="zd-backdrop" />
    </div>
  );
}

const SourcesModal = dynamic(() => import("./sources-modal").then((m) => m.SourcesModal), { ssr: false, loading: Loading });
const TeamModal = dynamic(() => import("./team-modal").then((m) => m.TeamModal), { ssr: false, loading: Loading });
const ZoteroModal = dynamic(() => import("./zotero-modal").then((m) => m.ZoteroModal), { ssr: false, loading: Loading });

export function ZdrojeModals() {
  const params = useSearchParams();
  const tab = params.get("zdroje");
  const team = params.get("tym");
  const doc = params.get("dokument");
  const zotero = params.get("zotero");
  const open = tab !== null && tab !== "";
  useEffect(() => setSourcesOpen(open), [open]);
  return (
    <>
      {open ? <SourcesModal tab={tab === "tym" ? "tym" : "moje"} documentId={doc && UUID_RE.test(doc) ? doc.toLowerCase() : null} /> : null}
      {team && !open ? <TeamModal orgParam={team} /> : null}
      {zotero !== null && !open && !team ? <ZoteroModal stav={params.get("stav")} /> : null}
    </>
  );
}
