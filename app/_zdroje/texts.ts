"use client";

import { createContext, useContext } from "react";
import { DEFAULT_TEXTS } from "@/src/content/texts";

/**
 * The editable lines under the rows of the Pro group (sources.* in
 * src/content/texts.ts). The home page reads them on the server and hands
 * them to OwnSourcesGroup, which provides them here to its rows; without a
 * provider (tests, another page) the rows show the defaults.
 */
export interface SourceTexts {
  files: string;
  zotero: string;
  ukaz: string;
}

export const DEFAULT_SOURCE_TEXTS: SourceTexts = {
  files: DEFAULT_TEXTS["sources.files"],
  zotero: DEFAULT_TEXTS["sources.zotero"],
  ukaz: DEFAULT_TEXTS["sources.ukaz"],
};

export const SourceTextsContext = createContext<SourceTexts>(DEFAULT_SOURCE_TEXTS);

export function useSourceTexts(): SourceTexts {
  return useContext(SourceTextsContext);
}
