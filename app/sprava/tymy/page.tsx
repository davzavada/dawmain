import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { listAdminUsers, requireAdmin } from "@/src/admin/server";
import { listAdminTeams } from "@/src/admin/teams";
import type { AdminTeam } from "@/src/admin/teams-model";
import { LIMITS } from "@/src/files/config";
import { AdminTabs } from "../_tabs";
import { TeamsConsole, type TeamPerson } from "./console";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Týmy · Správa · Dawmain", robots: { index: false, follow: false } };

/**
 * The Týmy tab of the admin area: every team (a Clerk organization) with its
 * members and the use of its shared library. A row opens the team: rename,
 * activate, quota, members and their roles. Admins only — anyone else gets
 * the same 404 as a page that does not exist. Every change goes through
 * changeTeamAction.
 */
export default async function TeamsPage() {
  const me = await requireAdmin();
  if (!me) notFound();

  let teams: AdminTeam[] = [];
  let people: TeamPerson[] = [];
  let failed = false;
  try {
    const [t, users] = await Promise.all([listAdminTeams(), listAdminUsers()]);
    teams = t.teams;
    people = users.map((u) => ({ id: u.id, name: u.name, email: u.email, imageUrl: u.imageUrl, pro: u.pro }));
  } catch {
    failed = true;
  }

  return (
    <div className="adm">
      <Link href="/" className="back">
        ← Hlavní stránka
      </Link>
      <header className="adm-head">
        <h1>Správa</h1>
        <p className="muted">Týmy a jejich sdílené soubory.</p>
      </header>
      <AdminTabs active="teams" />
      {failed ? (
        <p className="zd-error">Týmy se nepodařilo načíst z Clerku. Zkontroluj, že jsou v Clerku zapnuté Organizations, a obnov stránku.</p>
      ) : (
        <TeamsConsole teams={teams} people={people} defaultQuotaMb={Math.round(LIMITS.teamBytes / (1024 * 1024))} />
      )}
      <p className="muted small adm-foot">
        Tým má jednu sdílenou knihovnu Vlastních souborů. Každý člen v ní hledá a nahrává do ní, své nahrané soubory upravuje a maže; správce týmu spravuje všechny.
        Osobní soubory zůstávají každému zvlášť. Výchozí kvóta týmu se nastavuje proměnnou <code>FILES_TEAM_MB</code>.
      </p>
    </div>
  );
}
