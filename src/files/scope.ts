import "server-only";
import { SourceError } from "@/src/sources/shared/errors";
import type { Access, LibraryAccess } from "./access-types";
import { sanitizeLine } from "./dmd/normalize";
import { FilesUserError } from "./errors";

/**
 * Scopes: the set of libraries one request may touch, derived ONLY from the
 * caller's Access (src/files/access.ts) — never from input. Input can only
 * narrow a scope (a library filter), never widen it. `libraryIds` is what
 * goes into withScope() and into every `library_id = ANY($n)`.
 *
 *   readScope   Pro libraries — MCP search/read, status polling of uploads;
 *   writeScope  exactly one Pro library the caller may upload into;
 *   ownedScope  every library the caller owns or belongs to, Pro or not —
 *               list, delete, export after Pro was revoked.
 *
 * The brand makes a Scope constructible only here, so a function taking a
 * Scope cannot be handed a hand-built id list. Pure (no I/O) — unit-tested.
 */

declare const SCOPE_BRAND: unique symbol;

export interface Scope {
  readonly libraryIds: readonly string[];
  readonly libraries: readonly LibraryAccess[];
  readonly [SCOPE_BRAND]: true;
}

export interface WriteScope extends Scope {
  readonly library: LibraryAccess;
}

/** Filter words that mean "my personal library" (folded, no diacritics). */
const PERSONAL_ALIASES = new Set(["osobni", "moje", "muj", "personal", "me", "user", "vlastni"]);

function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .trim();
}

function makeScope(libraries: readonly LibraryAccess[]): Scope {
  const libs = Object.freeze([...libraries]);
  return Object.freeze({ libraryIds: Object.freeze(libs.map((l) => l.id)), libraries: libs }) as unknown as Scope;
}

/** Does one filter value name this library (by id, slug or the personal aliases)? */
export function matchesLibrary(lib: LibraryAccess, filter: string): boolean {
  const f = fold(filter);
  if (!f) return false;
  if (f === lib.id.toLowerCase()) return true;
  if (lib.slug && f === fold(lib.slug)) return true;
  return lib.kind === "user" && PERSONAL_ALIASES.has(f);
}

/** How a library is named in "available libraries" hints: name + the filter value to use. */
function describe(lib: LibraryAccess): string {
  const handle = lib.kind === "user" ? "osobni" : (lib.slug ?? lib.id);
  return `${lib.name} (library: "${handle}")`;
}

/**
 * The Pro libraries of the caller, optionally narrowed by `libraryFilter`
 * (one value or several; each an id, a team slug, or "osobni"). A filter
 * value that matches none of them throws SourceError INPUT_INVALID naming
 * the available libraries — the same answer whether the library exists
 * elsewhere or not at all.
 */
export function readScope(access: Access, libraryFilter?: string | readonly string[] | null): Scope {
  const base = access.banned ? [] : access.libraries;
  const filters = (typeof libraryFilter === "string" ? [libraryFilter] : (libraryFilter ?? []))
    .filter((f): f is string => typeof f === "string" && f.trim() !== "");
  if (filters.length === 0) return makeScope(base);
  const picked = new Set<string>();
  for (const filter of filters) {
    const hits = base.filter((lib) => matchesLibrary(lib, filter));
    if (hits.length === 0) {
      const available = base.map(describe).join(", ");
      throw new SourceError(
        "files",
        "INPUT_INVALID",
        `No library "${sanitizeLine(filter, 60)}" among this account's Vlastní zdroje libraries.`,
        available
          ? `Available: ${available}. Omit \`library\` to search all of them.`
          : "This account has no Vlastní zdroje library.",
      );
    }
    for (const lib of hits) picked.add(lib.id);
  }
  return makeScope(base.filter((lib) => picked.has(lib.id)));
}

/**
 * Exactly one library the caller may upload into: Pro, canUpload, not
 * banned. Anything else — foreign, unknown, not Pro — is one 403 with the
 * same message, so the answer reveals nothing about other libraries.
 */
export function writeScope(access: Access, libraryId: string): WriteScope {
  const lib = access.banned ? undefined : access.libraries.find((l) => l.id === libraryId);
  if (!lib || !lib.pro || !lib.canUpload) {
    throw new FilesUserError(403, "Do této knihovny nemůžete nahrávat.");
  }
  return Object.freeze({ ...makeScope([lib]), library: lib }) as WriteScope;
}

/**
 * Libraries the caller owns or belongs to, Pro or not (list, delete,
 * export). With `libraryId`, exactly that one; one the caller does not
 * belong to is "not found" (404), indistinguishable from a nonexistent one.
 */
export function ownedScope(access: Access, libraryId?: string | null): Scope {
  const all = access.banned ? [] : access.all;
  if (libraryId === undefined || libraryId === null) return makeScope(all);
  const lib = all.find((l) => l.id === libraryId);
  if (!lib) throw new FilesUserError(404, "Knihovna nenalezena.");
  return makeScope([lib]);
}
