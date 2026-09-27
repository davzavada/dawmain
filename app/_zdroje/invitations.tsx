"use client";

import { useOrganizationList } from "@clerk/nextjs";
import { useState } from "react";
import { sanitizeLine } from "@/src/files/dmd/normalize";
import { api } from "./api";
import { refreshSummary } from "./store";

/**
 * The invitee's side of team invitations (design 3a, 3b, 3e). Pending
 * invitations come from Clerk's frontend API; "Přijmout" is Clerk's own
 * accept(); "Odmítnout" goes through our server route (Clerk's frontend
 * API cannot decline — the server checks the address and revokes). Only
 * rendered inside ClerkProvider.
 */

export interface PendingInvitation {
  id: string;
  teamName: string;
  inviterName: string | null;
  accept(): Promise<unknown>;
}

export function useInvitations(): {
  invitations: PendingInvitation[];
  accept(id: string): Promise<string | null>;
  decline(id: string): Promise<string | null>;
  busy: string | null;
} {
  const { userInvitations } = useOrganizationList({ userInvitations: { status: "pending", pageSize: 20 } });
  const [busy, setBusy] = useState<string | null>(null);
  const invitations: PendingInvitation[] = (userInvitations?.data ?? []).map((inv) => {
    const inviter = inv.publicMetadata?.inviterName;
    return {
      id: inv.id,
      teamName: sanitizeLine(inv.publicOrganizationData?.name ?? "", 120) || "tým",
      inviterName: typeof inviter === "string" && inviter.trim() ? sanitizeLine(inviter, 80) : null,
      accept: () => inv.accept(),
    };
  });

  async function settle(): Promise<void> {
    await userInvitations?.revalidate?.();
    // The server re-reads access at most 2 s old after a join: ask now, and
    // once more in case Clerk had not propagated the membership yet.
    void refreshSummary({ fresh: true });
    window.setTimeout(() => void refreshSummary({ fresh: true }), 3_000);
  }

  return {
    invitations,
    busy,
    async accept(id) {
      const inv = invitations.find((i) => i.id === id);
      if (!inv) return "Pozvánka už neplatí.";
      setBusy(id);
      try {
        await inv.accept();
        await settle();
        return null;
      } catch {
        return "Pozvánku se nepodařilo přijmout. Zkuste to prosím znovu.";
      } finally {
        setBusy(null);
      }
    },
    async decline(id) {
      setBusy(id);
      try {
        const res = await api(`/api/files/team/invitations/${encodeURIComponent(id)}/decline`, { method: "POST", json: {} });
        if (!res.ok) return res.error;
        await settle();
        return null;
      } finally {
        setBusy(null);
      }
    },
  };
}

/** "Jana Nováková vás zve do týmu **Kancelář Novák & partneři**." */
export function InvitationText({ invitation, suffix }: { invitation: PendingInvitation; suffix?: string }) {
  return (
    <>
      {invitation.inviterName ? `${invitation.inviterName} vás zve do týmu ` : "Máte pozvánku do týmu "}
      <strong>{invitation.teamName}</strong>.{suffix ? ` ${suffix}` : ""}
    </>
  );
}

/** Přijmout / Odmítnout with the error line under them. */
export function InvitationActions({
  invitation,
  api: inv,
}: {
  invitation: PendingInvitation;
  api: ReturnType<typeof useInvitations>;
}) {
  const [error, setError] = useState<string | null>(null);
  const busy = inv.busy === invitation.id;
  return (
    <>
      <span className="zd-invite-actions">
        <button type="button" className="zd-btn zd-btn-primary zd-btn-tall" disabled={busy} onClick={async () => setError(await inv.accept(invitation.id))}>
          Přijmout
        </button>
        <button type="button" className="zd-btn zd-btn-secondary zd-btn-tall" disabled={busy} onClick={async () => setError(await inv.decline(invitation.id))}>
          Odmítnout
        </button>
      </span>
      {error ? (
        <span className="zd-error" role="alert">
          {error}
        </span>
      ) : null}
    </>
  );
}
