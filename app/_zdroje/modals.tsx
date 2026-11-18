"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { UUID_RE } from "@/src/files/config";
import { FILES_PARAM, LEGACY_FILES_PARAM } from "./store";

/**
 * Old links to what used to be modals, mounted once in the root layout:
 * ?soubory=1 (+ &dokument=<id>; ?zdroje=… before that) leads to the
 * Vlastní soubory page /soubory, ?zotero=1 to the /zotero page with &stav=
 * (the connect flow's outcome) kept. Both are pages now; e-mails, bookmarks
 * and assistants' answers still carry the parameters.
 */

/** Where ?zotero=1 leads now: the /zotero page, with the connect flow's outcome when there is one. */
export function zoteroPageHref(stav: string | null): string {
  return stav ? `/zotero?stav=${encodeURIComponent(stav)}` : "/zotero";
}

/** Where ?soubory=1 leads now: the personal library's page, with the document opened when the link named one. */
export function filesPageHref(doc: string | null): string {
  return doc && UUID_RE.test(doc) ? `/soubory?dokument=${doc.toLowerCase()}` : "/soubory";
}

export function ZdrojeModals() {
  const params = useSearchParams();
  const router = useRouter();
  const files = params.get(FILES_PARAM) ?? params.get(LEGACY_FILES_PARAM);
  const doc = params.get("dokument");
  const zotero = params.get("zotero");
  const stav = params.get("stav");
  const target = files !== null && files !== "" ? filesPageHref(doc) : zotero !== null ? zoteroPageHref(stav) : null;
  useEffect(() => {
    if (target) router.replace(target);
  }, [target, router]);
  return null;
}
