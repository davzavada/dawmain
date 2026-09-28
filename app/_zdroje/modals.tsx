"use client";

import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { UUID_RE } from "@/src/files/config";
import { setSourcesOpen } from "./store";

/**
 * The Vlastní zdroje modal (design 2b–2e) and the team modal (3d, 3f),
 * mounted once in the root layout and driven by the URL: ?zdroje=moje|tym
 * (+ &dokument=<id> for a document's detail), ?tym=<org id>. Deep links and
 * the old /vlastni-zdroje route (which redirects here) open them; closing
 * removes the parameter.
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

export function ZdrojeModals() {
  const params = useSearchParams();
  const tab = params.get("zdroje");
  const team = params.get("tym");
  const doc = params.get("dokument");
  const open = tab !== null && tab !== "";
  useEffect(() => setSourcesOpen(open), [open]);
  return (
    <>
      {open ? <SourcesModal tab={tab === "tym" ? "tym" : "moje"} documentId={doc && UUID_RE.test(doc) ? doc.toLowerCase() : null} /> : null}
      {team && !open ? <TeamModal orgParam={team} /> : null}
    </>
  );
}
