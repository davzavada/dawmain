import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { listAdminUsers, requireAdmin } from "@/src/admin/server";
import type { AdminUser } from "@/src/admin/model";
import { withScope } from "@/src/files/db/client";
import { callUsage, type CallerUsage } from "@/src/files/db/usage";
import { effectiveMode } from "@/src/files/guards";
import { AdminConsole, type AdminRow } from "./console";
import { AdminTabs } from "./_tabs";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Správa · Dawmain", robots: { index: false, follow: false } };

/** The window of the usage numbers, in UTC days including today. */
const WINDOW_DAYS = 30;

/**
 * The admin page: every account with its role, Pro and feature switches and
 * the use of the MCP tools (counts per day and tool, never the content of a
 * call). Admins only — anyone else, signed in or not, gets the same 404 as a
 * page that does not exist. Every change goes through changeUserAction.
 */

/** The call counters, or null where they are not kept (no files database, FILES_MODE=off, or the guards turned it off). */
async function loadUsage(): Promise<CallerUsage[] | null> {
  try {
    const mode = await effectiveMode();
    if (mode === "off" || mode === "unconfigured") return null;
    return await withScope([], (db) => callUsage(db, WINDOW_DAYS));
  } catch {
    return null;
  }
}

export default async function AdminPage() {
  const me = await requireAdmin();
  if (!me) notFound();

  let users: AdminUser[] = [];
  let failed = false;
  try {
    users = await listAdminUsers();
  } catch {
    failed = true;
  }
  const usage = await loadUsage();
  const byWho = new Map((usage ?? []).map((u) => [u.who, u]));
  const rows: AdminRow[] = users.map((user) => {
    const u = byWho.get(user.id);
    return { user, usage: u ? { calls: u.calls, calls7: u.calls7, lastDay: u.lastDay, daily: u.daily, tools: u.tools } : null };
  });
  const noAccount = {
    shared: byWho.get("shared")?.calls ?? 0,
    anon: byWho.get("anon")?.calls ?? 0,
  };

  return (
    <div className="adm">
      <Link href="/" className="back">
        ← Hlavní stránka
      </Link>
      <header className="adm-head">
        <h1>Správa</h1>
        <p className="muted">Uživatelé, oprávnění a využití.</p>
      </header>
      <AdminTabs active="users" />
      {failed ? (
        <p className="zd-error">Účty se nepodařilo načíst z Clerku. Zkus stránku obnovit za chvíli.</p>
      ) : (
        <AdminConsole
          rows={rows}
          me={me}
          today={new Date().toISOString().slice(0, 10)}
          windowDays={WINDOW_DAYS}
          usageAvailable={usage !== null}
          noAccount={noAccount}
        />
      )}
      <p className="muted small adm-foot">
        První správce se zapíše do proměnné <code>ADMIN_USER_IDS</code> ve Vercelu (Clerk id, <code>user_…</code>). Ten pak další správce povyšuje tady a
        proměnná zůstává jako cesta zpět. K Vlastním zdrojům a pojistkám limitů: <Link href="/vlastni-zdroje/provoz">Provoz</Link>.
      </p>
    </div>
  );
}
