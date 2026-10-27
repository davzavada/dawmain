import type { Queryable } from "../db/client";
import type { ActLookup } from "./provisions";

/**
 * The registry side of the extractor (ActLookup): names from the official
 * titles ("zákon o obchodních korporacích") found by the words after "o",
 * and the global aliases mined from the case law. Built once per run from
 * mirror.act_alias; buildActLookup is pure — unit-tested.
 */

export interface NameRow {
  alias: string; // "zákon o obchodních korporacích"
  act_id: string;
  year: number | null;
}

export interface AliasEntry {
  alias: string;
  act_id: string;
  year: number | null;
}

const KINDS = ["ústavní zákon", "zákon", "vyhláška", "nařízení vlády"] as const;

/** Lowercase words with case-insensitive comparison in mind; the first two words key the index. */
const words = (s: string) => s.toLowerCase().normalize("NFC").match(/[\p{L}\p{N}]+/gu) ?? [];

interface Candidate {
  subject: string[];
  act: string;
  year: number | null;
}

/** Among acts sharing a name: the newest issued by the decision's year, else the newest. */
function pick(cands: Candidate[], year: number | null): Candidate {
  const sorted = [...cands].sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
  return (year !== null ? sorted.find((c) => (c.year ?? 0) <= year) : undefined) ?? sorted[0];
}

export function buildActLookup(names: NameRow[], aliases: AliasEntry[] = []): ActLookup {
  // kind → "first second" words of the subject → candidates
  const index = new Map<string, Map<string, Candidate[]>>();
  for (const row of names) {
    const kind = KINDS.find((k) => row.alias.toLowerCase().startsWith(`${k} o `));
    if (!kind) continue;
    const subject = words(row.alias.slice(kind.length + 3));
    if (subject.length < 2) continue;
    const key = `${subject[0]} ${subject[1]}`;
    const byKey = index.get(kind) ?? new Map<string, Candidate[]>();
    byKey.set(key, [...(byKey.get(key) ?? []), { subject, act: row.act_id, year: row.year }]);
    index.set(kind, byKey);
  }
  return {
    byName(kind, text, year) {
      const tokens = [...text.matchAll(/[\p{L}\p{N}]+/gu)];
      if (tokens.length < 2) return null;
      const key = `${tokens[0][0].toLowerCase()} ${tokens[1][0].toLowerCase()}`;
      const cands = index.get(kind)?.get(key);
      if (!cands) return null;
      // The longest subject the text starts with, word by word.
      let bestLen = 0;
      let best: Candidate[] = [];
      for (const c of cands) {
        if (c.subject.length > tokens.length) continue;
        if (!c.subject.every((w, i) => tokens[i][0].toLowerCase() === w)) continue;
        if (c.subject.length > bestLen) [bestLen, best] = [c.subject.length, [c]];
        else if (c.subject.length === bestLen) best.push(c);
      }
      if (!best.length) return null;
      const last = tokens[bestLen - 1];
      return { act: pick(best, year).act, length: last.index! + last[0].length };
    },
    aliases(year) {
      const byAlias = new Map<string, Candidate[]>();
      for (const a of aliases) byAlias.set(a.alias, [...(byAlias.get(a.alias) ?? []), { subject: [], act: a.act_id, year: a.year }]);
      return [...byAlias].map(([alias, cands]) => [alias, pick(cands, year).act] as [string, string]);
    },
  };
}

/** The lookup from the registry: title names, and the case-law aliases that are not generic words. */
export async function loadActLookup(db: Queryable): Promise<ActLookup> {
  const { rows: names } = await db.query<NameRow & Record<string, unknown>>(
    `SELECT al.alias, al.act_id, a.year FROM mirror.act_alias al JOIN mirror.act a ON a.id = al.act_id
     WHERE al.kind = 'name' AND al.origin IN ('title', 'manual', 'table')`,
  );
  const { rows: aliases } = await db.query<AliasEntry & Record<string, unknown>>(
    `SELECT al.alias, al.act_id, a.year FROM mirror.act_alias al JOIN mirror.act a ON a.id = al.act_id
     WHERE al.origin = 'caselaw'`,
  );
  return buildActLookup(names, aliases);
}
