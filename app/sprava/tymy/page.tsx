import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { listAdminUsers, requireAdmin } from "@/src/admin/server";
import { listAdminTeams } from "@/src/admin/teams-server";
import { LIMITS } from "@/src/files/config";
import { AdminTabs } from "../_tabs";
import { TeamsConsole, type TeamCandidate } from "./console";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Týmy · Správa · Dawmain", robots: { index: false, follow: false } };

/**
 * Týmy: every team (src/files/db/teams.ts) with its switches, its shared
 * library's quota and its members. A team that is on gives its members a
 * shared library of Vlastní soubory and the team's features, with no Pro
 * of their own. Admins only — anyone else gets the same 404 as a page that
 * does not exist. Every change goes through the Server Functions in
 * ./actions.ts.
 */
export default async function TeamsPage() {
  const me = await requireAdmin();
  if (!me) notFound();

  const [load, users] = await Promise.all([listAdminTeams(), listAdminUsers().catch(() => null)]);
  const people: TeamCandidate[] = (users ?? []).map((u) => ({ id: u.id, name: u.name, email: u.email, banned: u.banned }));

  return (
    <div className="adm">
      <Link href="/" className="back">
        ← Hlavní stránka
      </Link>
      <header className="adm-head">
        <h1>Správa</h1>
        <p className="muted">Týmy a jejich sdílené knihovny.</p>
      </header>
      <AdminTabs active="teams" />
      {load.state === "unconfigured" ? (
        <p className="zd-error">Týmy potřebují databázi Vlastních souborů, která na tomto nasazení není nastavená.</p>
      ) : load.state === "failed" || users === null ? (
        <p className="zd-error">Týmy se nepodařilo načíst. Zkus stránku obnovit za chvíli.</p>
      ) : (
        <TeamsConsole teams={load.teams} people={people} defaultQuotaPages={LIMITS.teamPages} />
      )}
      <p className="muted small adm-foot">
        Zapnutý tým dává členům sdílenou knihovnu Vlastních souborů a své funkce, i když sami Pro nemají. Správce týmu
        spravuje všechny jeho soubory, člen nahrává a spravuje ty své. Změna se projeví do minuty.
      </p>
    </div>
  );
}
