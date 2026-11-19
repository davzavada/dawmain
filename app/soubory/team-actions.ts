"use server";

import { cleanTeamManageChange, manageTeam, teamPanel, type TeamManageResult, type TeamPanel } from "@/src/admin/team-manage";

/**
 * Server Functions of "Spravovat tým" on a team's files page. Public
 * endpoints: src/admin/team-manage.ts checks the caller's rights on every
 * call and rebuilds the change from its validated fields only.
 */
export async function teamPanelAction(teamId: unknown): Promise<TeamPanel | null> {
  if (typeof teamId !== "string") return null;
  return teamPanel(teamId);
}

export async function teamManageAction(teamId: unknown, change: unknown): Promise<TeamManageResult> {
  if (typeof teamId !== "string") return { ok: false, error: "Neplatný tým." };
  const clean = cleanTeamManageChange(change);
  if (!clean) {
    const kind = (change as { kind?: unknown } | null)?.kind;
    if (kind === "addByEmail") return { ok: false, error: "Zadejte platný e-mail." };
    if (kind === "rename") return { ok: false, error: "Název týmu: 2 až 60 znaků, písmena, číslice a běžná interpunkce." };
    return { ok: false, error: "Neplatná změna." };
  }
  return manageTeam(teamId, clean);
}
