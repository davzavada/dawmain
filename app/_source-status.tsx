"use client";

import { useEffect, useState, type ReactNode } from "react";
import {
  DATABASE_GROUPS,
  DATABASES,
  formatTime,
  type DatabaseGroup,
  type DatabaseStatus,
  type MirrorCounts,
} from "@/src/mcp/databases";
import { Icon, type IconName } from "./_icons";
import { useZdroje } from "./_zdroje/store";
import { useSourceTexts } from "./_zdroje/texts";

/**
 * The source checks in the browser: the summary in the header and the
 * badges on the home page. Both read GET /api/status once the page is up -
 * a static answer the server serves from its cache at once, regenerated at most every 14 minutes
 * (app/api/status/route.ts) - so no page waits on it.
 */

/** undefined while loading, null when the check could not be read. */
type Answer = DatabaseStatus | null | undefined;
type Answers = Record<string, Answer>;

/** One request per page load, shared by the header and the list; reused this long across client navigations. */
const REUSE_MS = 60 * 1000;
let asked: { at: number; answer: Promise<Answers> } | undefined;

function isStatus(v: unknown): v is DatabaseStatus {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    (o.ok === null || typeof o.ok === "boolean") &&
    (o.at === null || typeof o.at === "number") &&
    (o.detail === undefined || typeof o.detail === "string")
  );
}

/** Every database's answer by canary id; null for one the server did not report. */
function toAnswers(body: unknown): Answers {
  const list = Array.isArray(body) ? body.filter(isStatus) : [];
  return Object.fromEntries(DATABASES.map(({ canaryId }) => [canaryId, list.find((s) => s.id === canaryId) ?? null]));
}

function load(): Promise<Answers> {
  if (asked && Date.now() - asked.at <= REUSE_MS) return asked.answer;
  const answer = fetch("/api/status")
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
    .then(toAnswers);
  asked = { at: Date.now(), answer };
  return answer;
}

/** Every database's answer; empty (all pending) until the one request returns. */
function useStatuses(): Answers {
  const [answers, setAnswers] = useState<Answers>({});
  useEffect(() => {
    let live = true;
    load().then((all) => {
      if (live) setAnswers(all);
    });
    return () => {
      live = false;
    };
  }, []);
  return answers;
}

// ---------------------------------------------------------------------------
// The header summary

function Summary({ state, text }: { state: "ok" | "down" | "pending" | "unknown"; text: string }) {
  return (
    <span className="summary">
      <span className="summary-dot" data-state={state} aria-hidden="true" />
      {text}
    </span>
  );
}

export function StatusSummary() {
  const answers = useStatuses();
  if (DATABASES.some((db) => answers[db.canaryId] === undefined)) return <Summary state="pending" text="Ověřuji zdroje…" />;
  const known = DATABASES.map((db) => answers[db.canaryId]).filter((s): s is DatabaseStatus => !!s && s.ok !== null);
  if (known.length === 0) return <Summary state="unknown" text="Stav zdrojů neověřen" />;
  const up = known.filter((s) => s.ok).length;
  const total = DATABASES.length;
  const at = formatTime(Math.max(...known.map((s) => s.at!)));
  return up === total ? (
    <Summary state="ok" text={`Všechny zdroje dostupné · ${at}`} />
  ) : (
    <Summary state="down" text={`${up} z ${total} zdrojů dostupných · ${at}`} />
  );
}

// ---------------------------------------------------------------------------
// The home page list

/** Each database's icon and tint, keyed by its canary id. */
const LOOK: Record<string, { icon: IconName; color: string }> = {
  ns: { icon: "court", color: "var(--indigo)" },
  nss: { icon: "scale", color: "var(--teal)" },
  nalus: { icon: "shield", color: "var(--rose)" },
  justice: { icon: "court", color: "var(--soft)" },
  curia: { icon: "eu", color: "var(--blue)" },
  "esbirka-api": { icon: "list", color: "var(--green)" },
  "cellar-sparql": { icon: "eu", color: "var(--blue)" },
  "slovlex-zbierka": { icon: "list", color: "var(--green)" },
  "slovlex-lp": { icon: "list", color: "var(--soft)" },
  "slovlex-sudy": { icon: "court", color: "var(--indigo)" },
};

/** A group's flag in front of its heading (a static SVG, not an emoji: those render as letters on Windows). */
const GROUP_FLAG: Partial<Record<DatabaseGroup, string>> = { Slovensko: "/flag-sk.svg" };

/** What a row needs to render; a pending row has no status yet. */
type Row = Pick<DatabaseStatus, "id" | "label" | "group" | "href"> & {
  state: "ok" | "down" | "pending" | "unknown";
  badge: string;
  at?: string;
  mirror?: (typeof DATABASES)[number]["mirror"];
};

/** A database's row: its status when the check has one, "zjišťuji…" while
 * loading, "neověřeno" when nothing is known. The names always come from
 * DATABASES — a hand-kept copy would go on promising a database the server
 * no longer queries. */
function toRow({ canaryId: id, label, group, href, mirror }: (typeof DATABASES)[number], status: Answer): Row {
  const base = { id, label, group, href, mirror };
  if (status === undefined) return { ...base, state: "pending", badge: "zjišťuji…" };
  if (!status || status.ok === null || status.at === null) return { ...base, state: "unknown", badge: "neověřeno" };
  return {
    ...base,
    state: status.ok ? "ok" : "down",
    badge: status.ok ? "dostupné" : (status.detail ?? "nedostupné"),
    at: formatTime(status.at),
  };
}

function host(href: string): string {
  return new URL(href).host;
}

// The decision counts of the mirrored courts: one static request, like the statuses.
let askedCounts: Promise<MirrorCounts> | undefined;

function useMirrorCounts(): MirrorCounts | undefined {
  const [counts, setCounts] = useState<MirrorCounts | undefined>(undefined);
  useEffect(() => {
    let live = true;
    askedCounts ??= fetch("/api/status/mirror")
      .then((r) => (r.ok ? r.json() : {}))
      .catch(() => ({}))
      .then((body: unknown) => (body && typeof body === "object" && !Array.isArray(body) ? (body as MirrorCounts) : {}));
    askedCounts.then((c) => {
      if (live) setCounts(c);
    });
    return () => {
      live = false;
    };
  }, []);
  return counts;
}

/**
 * The public databases under their headings, each group in its own box. The
 * courts the case-law mirror holds open Judikatura as "Interní databáze",
 * with how many decisions each holds; the rest show their status light.
 */
export function SourceList({ groups = DATABASE_GROUPS }: { groups?: readonly DatabaseGroup[] } = {}) {
  const answers = useStatuses();
  const counts = useMirrorCounts();
  const rows = DATABASES.map((db) => toRow(db, answers[db.canaryId]));
  return groups.map((group) => {
    const items = rows.filter((row) => row.group === group);
    const mirrored = items.filter((row) => row.mirror);
    const live = items.filter((row) => !row.mirror);
    return (
      <div key={group} className="source-group">
        <div className="source-group-head">
          {GROUP_FLAG[group] ? <img className="source-group-flag" src={GROUP_FLAG[group]} alt="" width={18} height={12} /> : null}
          <h3 className="source-group-name">{group}</h3>
        </div>
        {mirrored.length > 0 ? (
          <div className="source-box source-box-mirror">
            <div className="source-box-head">
              <Icon name="database" size={14} />
              <span className="source-box-name">Interní databáze</span>
            </div>
            <p className="source-box-note">Rozhodnutí českých soudů hledá Dawmain ve vlastní, pravidelně aktualizované kopii.</p>
            <ul>
              {mirrored.map((row) => (
                <DatabaseRow key={row.id} row={row} count={row.mirror ? counts?.[row.mirror] : undefined} countLoading={counts === undefined} />
              ))}
            </ul>
          </div>
        ) : null}
        {live.length > 0 ? (
          <div className="source-box">
            <ul>
              {live.map((row) => (
                <DatabaseRow key={row.id} row={row} />
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    );
  });
}

/** `countLoading`: a mirrored court's count is still on its way — a shimmering bar in its place, not the status light. */
function DatabaseRow({ row, count, countLoading = false }: { row: Row; count?: number; countLoading?: boolean }) {
  const look = LOOK[row.id] ?? { icon: "list", color: "var(--soft)" };
  return (
    <li className="source">
      <Icon name={look.icon} style={{ color: look.color }} />
      <div className="source-name">
        <a href={row.href}>{row.label}</a>
        <span className="source-host">{host(row.href)}</span>
      </div>
      {count !== undefined ? (
        <DecisionCount value={count} />
      ) : countLoading ? (
        <span className="source-count" aria-hidden="true">
          <span className="zd-shimmer zd-shimmer-late source-count-shimmer" />
        </span>
      ) : (
        <StateDot row={row} />
      )}
    </li>
  );
}

/**
 * The decision counts run up from zero the first time this tab shows them
 * (about a second, easing out); a reload, a later visit in the same tab or
 * reduced motion shows them at once. Remembered in sessionStorage.
 */
const COUNTED_KEY = "dm-counted";
const COUNT_MS = 1100;
let countedThisLoad: boolean | undefined;

function shouldCount(): boolean {
  if (countedThisLoad !== undefined) return countedThisLoad;
  let seen = false;
  try {
    seen = window.sessionStorage.getItem(COUNTED_KEY) === "1";
    window.sessionStorage.setItem(COUNTED_KEY, "1");
  } catch {
    seen = true; // no storage: no animation rather than one on every reload
  }
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  countedThisLoad = !seen && !reduced;
  return countedThisLoad;
}

function useCountUp(target: number): number {
  const [shown, setShown] = useState(() => (typeof window !== "undefined" && shouldCount() ? 0 : target));
  useEffect(() => {
    if (!shouldCount()) {
      setShown(target);
      return;
    }
    let frame = 0;
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / COUNT_MS);
      setShown(Math.round(target * (1 - Math.pow(1 - t, 3))));
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target]);
  return shown;
}

function DecisionCount({ value }: { value: number }) {
  return <span className="source-count">{formatDecisions(useCountUp(value))}</span>;
}

function formatDecisions(n: number): string {
  return `${n.toLocaleString("cs-CZ")} rozhodnutí`;
}

/** The status as a light; the words (and the time of the check) for the tooltip and screen readers. */
function StateDot({ row }: { row: Row }) {
  const text = row.at ? `${row.badge} · ${row.at}` : row.badge;
  return (
    <span className="source-dot" data-state={row.state} title={text}>
      <span className="sr-only">{text}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// UKAŽ in the Pro group

const UKAZ = DATABASES.find((db) => db.canaryId === "primo")!;

/**
 * The UKAŽ row of the Pro group (app/_zdroje/own-sources.tsx): switched on
 * per account by an admin, so greyed out with a lock until then. A visitor
 * gets the group's lock and a click signs them in, as on the other rows.
 * Switched on, it shows its check as the public databases do; only then is
 * the status asked for.
 */
export function UkazRow({ signedIn }: { signedIn: boolean }) {
  const { summary } = useZdroje();
  // A hidden feature: only an account an admin switched it on for sees it at all.
  if (!signedIn || summary?.state !== "ok" || summary.ukaz !== true) return null;
  return <UkazRowOn />;
}

/** Switched on: the same card as for visitors, without the lock; the whole card opens the catalogue. */
function UkazRowOn() {
  return (
    <UkazRowView>
      <a href={UKAZ.href} className="source-title zd-row-button">
        {UKAZ.label}
      </a>
    </UkazRowView>
  );
}

function UkazRowView({ locked = false, children }: { locked?: boolean; children: ReactNode }) {
  // What UKAŽ is, worded as the other rows of the Pro group are — an editable text (sources.ukaz).
  const texts = useSourceTexts();
  return (
    <li className={locked ? "source zd-own-row zd-row-locked" : "source zd-own-row"}>
      <Icon name="book" />
      <div className="source-name">
        {children}
        <span className="source-desc">{texts.ukaz}</span>
      </div>
    </li>
  );
}
