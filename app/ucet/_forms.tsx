"use client";

import { useActionState } from "react";
import { deleteLibraryLogin, saveLibraryLogin, type ActionState } from "./actions";

/**
 * The two forms of /ucet, one per library: save a login, remove it. Client
 * components only for the pending state and the message — the work happens
 * in the server actions.
 */

const idle: ActionState = { ok: true, message: "" };

const input: React.CSSProperties = {
  font: "inherit",
  padding: "0.4rem 0.6rem",
  border: "1px solid #d1d5db",
  borderRadius: "0.375rem",
  width: "100%",
  boxSizing: "border-box",
};

const button: React.CSSProperties = {
  font: "inherit",
  fontSize: "0.9rem",
  padding: "0.4rem 0.9rem",
  border: "1px solid #d1d5db",
  borderRadius: "0.375rem",
  background: "#ffffff",
  color: "#111827",
  cursor: "pointer",
};

export function LibraryLoginForm({
  library,
  label,
  hint,
  stored,
}: {
  library: string;
  label: string;
  hint: string;
  stored: { username: string; updatedAt: string; usable: boolean } | null;
}) {
  const [saved, save, saving] = useActionState(saveLibraryLogin, idle);
  const [removed, remove, removing] = useActionState(deleteLibraryLogin, idle);
  const message = saved.message || removed.message;
  const ok = saved.message ? saved.ok : removed.ok;

  return (
    <section style={{ border: "1px solid #e5e7eb", borderRadius: "0.5rem", padding: "1rem 1.25rem", marginTop: "1.25rem" }}>
      <h2 style={{ fontSize: "1.05rem", margin: "0 0 0.25rem" }}>{label}</h2>
      <p style={{ color: "#6b7280", fontSize: "0.9rem", margin: "0 0 0.75rem" }}>{hint}</p>
      <p style={{ fontSize: "0.9rem", margin: "0 0 0.75rem" }}>
        {stored ? (
          <>
            Uloženo pro <strong>{stored.username}</strong>
            {stored.updatedAt ? ` (${new Date(stored.updatedAt).toLocaleDateString("cs-CZ")})` : ""}.{" "}
            {stored.usable
              ? "Heslo se nezobrazuje; nové uložení ho přepíše."
              : "Uložené heslo už server nedokáže přečíst (změnil se jeho klíč) - zadejte ho prosím znovu."}
          </>
        ) : (
          "Zatím nic uloženo."
        )}
      </p>
      <form action={save} style={{ display: "grid", gap: "0.5rem", gridTemplateColumns: "1fr 1fr auto", alignItems: "end" }}>
        <input type="hidden" name="library" value={library} />
        <label style={{ fontSize: "0.85rem" }}>
          Přihlašovací jméno
          <input name="username" autoComplete="off" required maxLength={200} defaultValue={stored?.username ?? ""} style={input} />
        </label>
        <label style={{ fontSize: "0.85rem" }}>
          Heslo
          <input name="password" type="password" autoComplete="new-password" required maxLength={500} style={input} />
        </label>
        <button type="submit" disabled={saving} style={button}>
          {saving ? "Ukládám…" : "Uložit"}
        </button>
      </form>
      {stored ? (
        <form action={remove} style={{ marginTop: "0.5rem" }}>
          <input type="hidden" name="library" value={library} />
          <button type="submit" disabled={removing} style={{ ...button, color: "#b91c1c" }}>
            {removing ? "Mažu…" : "Smazat uložené přihlášení"}
          </button>
        </form>
      ) : null}
      {message ? (
        <p role="status" style={{ marginTop: "0.75rem", fontSize: "0.9rem", color: ok ? "#166534" : "#b91c1c" }}>
          {message}
        </p>
      ) : null}
    </section>
  );
}
