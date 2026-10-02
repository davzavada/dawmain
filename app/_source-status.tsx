"use client";

import { useEffect, useState } from "react";
import {
  DATABASE_GROUPS,
  DATABASES,
  formatTime,
  type DatabaseStatus,
} from "@/src/mcp/databases";
import { Icon, type IconName } from "./_icons";

/**
 * The source checks in the browser: the summary in the header and the
 * badges on the home page. Each badge asks GET /api/status/[id] for its own
 * source after the page is up, so a slow source delays only its own badge,
 * never the page or the other badges.
 */

/** undefined while loading, null when the check could not be read. */
type Answer = DatabaseStatus | null | undefined;
type Answers = Record<string, Answer>;

/** One request per source and page load, shared by the header and the list; reused this long across client navigations. */
const REUSE_MS = 60 * 1000;
const asked = new Map<string, { at: number; answer: Promise<DatabaseStatus | null> }>();

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

function load(id: string): Promise<DatabaseStatus | null> {
  const hit = asked.get(id);
  if (hit && Date.now() - hit.at <= REUSE_MS) return hit.answer;
  const answer = fetch(`/api/status/${encodeURIComponent(id)}`)
    .then((r) => (r.ok ? r.json() : null))
    .then((body: unknown) => (isStatus(body) ? body : null))
    .catch(() => null);
  asked.set(id, { at: Date.now(), answer });
  return answer;
}

/** Every database's answer, filled in one by one as they arrive. */
function useStatuses(): Answers {
  const [answers, setAnswers] = useState<Answers>({});
  useEffect(() => {
    let live = true;
    for (const { canaryId } of DATABASES) {
      load(canaryId).then((status) => {
        if (live) setAnswers((prev) => ({ ...prev, [canaryId]: status }));
      });
    }
    return () => {
      live = false;
    };
  }, []);
  return answers;
}

// ---------------------------------------------------------------------------
// The header summary

function Summary({ state, text }: { state: "ok" | "down" | "pending"; text: string }) {
  return (
    <span className="summary">
      <span className="summary-dot" data-state={state} aria-hidden="true" />
      {text}
    </span>
  );
}

export function StatusSummary() {
  const answers = useStatuses();
  // The summary speaks for all sources, so it waits for all of them (each at most a few seconds).
  if (DATABASES.some((db) => answers[db.canaryId] === undefined)) return <Summary state="pending" text="Ověřuji zdroje…" />;
  const known = DATABASES.map((db) => answers[db.canaryId]).filter((s): s is DatabaseStatus => !!s && s.ok !== null);
  if (known.length === 0) return <Summary state="pending" text="Stav zdrojů neověřen" />;
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
  justice: { icon: "court", color: "#52525b" },
  curia: { icon: "eu", color: "var(--blue)" },
  "esbirka-api": { icon: "list", color: "var(--green)" },
  "cellar-sparql": { icon: "eu", color: "var(--blue)" },
  primo: { icon: "book", color: "var(--amber)" },
};

/** What a row needs to render; a pending row has no status yet. */
type Row = Pick<DatabaseStatus, "id" | "label" | "group" | "href"> & {
  state: "ok" | "down" | "pending" | "unknown";
  badge: string;
  at?: string;
};

/** A database's row: its status when the check has one, "zjišťuji…" while
 * loading, "neověřeno" when nothing is known. The names always come from
 * DATABASES — a hand-kept copy would go on promising a database the server
 * no longer queries. */
function toRow({ canaryId: id, label, group, href }: (typeof DATABASES)[number], status: Answer): Row {
  const base = { id, label, group, href };
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

export function SourceList() {
  const answers = useStatuses();
  const rows = DATABASES.map((db) => toRow(db, answers[db.canaryId]));
  return DATABASE_GROUPS.map((group) => {
    const items = rows.filter((row) => row.group === group);
    return (
      <div key={group} className="source-group">
        <div className="source-group-head">
          <span className="source-group-name">{group}</span>
          <span className="source-group-count">{items.length}</span>
        </div>
        <ul>
          {items.map((row) => {
            const look = LOOK[row.id] ?? { icon: "list", color: "#52525b" };
            return (
              <li key={row.id} className="source">
                <Icon name={look.icon} style={{ color: look.color }} />
                <div className="source-name">
                  <a href={row.href}>{row.label}</a>
                  <span className="source-host">{host(row.href)}</span>
                </div>
                <div className="source-state">
                  {row.at && <span className="source-at">{row.at}</span>}
                  <span className="badge" data-state={row.state}>
                    {row.badge}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    );
  });
}
