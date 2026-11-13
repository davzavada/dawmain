import "server-only";
import { databaseUrl } from "@/src/files/config";
import { withScope } from "@/src/files/db/client";
import { getSystemState, setSystemState } from "@/src/files/db/usage";
import { checkText, cleanOverrides, resolveTexts, textField, type SiteTexts, type TextOverrides } from "./texts";

/**
 * Where the edited texts live: one JSON object under system_state
 * 'site_texts' in the files database — the overrides only, by field key.
 *
 * The public pages stay static. They read the texts when they are built
 * and again after an admin saves (the save revalidates them,
 * app/sprava/texty/actions.ts), never per visit — a visit must not wake the
 * database. Whatever goes wrong while reading (no database configured, it
 * does not answer, the value is not what was stored), the pages show the
 * defaults from the repository instead of failing.
 */

export const SITE_TEXTS_KEY = "site_texts";

/** A read may not hold a build or a page render for long. */
const READ_TIMEOUT_MS = 5_000;

export interface LoadedTexts {
  texts: SiteTexts;
  overrides: TextOverrides;
  /** false: the database is not configured or did not answer — these are the defaults, and nothing can be saved. */
  available: boolean;
}

function defaults(): LoadedTexts {
  return { texts: resolveTexts({}), overrides: {}, available: false };
}

async function readOverrides(): Promise<TextOverrides> {
  return cleanOverrides(await withScope([], (db) => getSystemState<unknown>(db, SITE_TEXTS_KEY), { statementTimeoutMs: READ_TIMEOUT_MS }));
}

/** The texts with their state, for the editor. Never throws. */
export async function loadSiteTexts(): Promise<LoadedTexts> {
  if (!databaseUrl()) return defaults();
  try {
    const overrides = await readOverrides();
    return { texts: resolveTexts(overrides), overrides, available: true };
  } catch (error) {
    console.warn("site texts: read failed, showing the defaults —", error instanceof Error ? error.message : String(error));
    return defaults();
  }
}

/** The texts a page renders. Never throws. */
export async function siteTexts(): Promise<SiteTexts> {
  return (await loadSiteTexts()).texts;
}

export type SaveResult = { ok: true; overrides: TextOverrides } | { ok: false; error: string };

/**
 * Store one field (`value` null = back to the default). Read-modify-write
 * of the one object: two admins saving different fields within the same
 * second could lose one of the saves — the editor shows what the save
 * returned, so the loss is visible, and there are a handful of admins.
 */
export async function saveSiteText(key: string, value: string | null): Promise<SaveResult> {
  if (!databaseUrl()) return { ok: false, error: "Databáze není nastavená, texty tady upravit nejde." };
  let text: string | null = null;
  if (value !== null) {
    const checked = checkText(key, value);
    if (!checked.ok) return checked;
    text = checked.text === checked.field.default ? null : checked.text;
  } else if (!textField(key)) {
    return { ok: false, error: "Neznámé pole." };
  }
  try {
    const overrides = await withScope([], async (db) => {
      const current: Record<string, string> = { ...cleanOverrides(await getSystemState<unknown>(db, SITE_TEXTS_KEY)) };
      if (text === null) delete current[key];
      else current[key] = text;
      await setSystemState(db, SITE_TEXTS_KEY, current);
      return cleanOverrides(current);
    });
    return { ok: true, overrides };
  } catch (error) {
    console.warn("site texts: save failed —", error instanceof Error ? error.message : String(error));
    return { ok: false, error: "Uložení se nepovedlo, databáze neodpověděla. Zkus to za chvíli." };
  }
}
