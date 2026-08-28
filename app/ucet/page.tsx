import { redirect } from "next/navigation";
import { auth, clerkClient, currentUser } from "@clerk/nextjs/server";
import { clerkConfigured } from "@/src/mcp/config";
import { readUsage } from "@/src/mcp/usage";

export const dynamic = "force-dynamic";
export const metadata = { title: "Správa účtu - Dawmain" };

const card: React.CSSProperties = {
  border: "1px solid #e5e7eb",
  borderRadius: "0.75rem",
  padding: "1.25rem",
  marginTop: "1rem",
};

const label: React.CSSProperties = { color: "#6b7280", fontSize: "0.8rem", margin: 0 };

/** "srpen 2026" from a "2026-08" key. */
function monthName(key: string): string {
  const [year, month] = key.split("-").map(Number);
  const formatted = new Intl.DateTimeFormat("cs-CZ", { month: "long", year: "numeric" }).format(
    new Date(Date.UTC(year, month - 1, 1)),
  );
  return formatted.charAt(0).toUpperCase() + formatted.slice(1);
}

export default async function Ucet() {
  // Without Clerk keys there is no user store to show — the endpoint then runs
  // on the shared access code alone, which has no account behind it.
  if (!clerkConfigured()) {
    return (
      <>
        <h1 style={{ fontSize: "1.6rem" }}>Správa účtu</h1>
        <p>Na tomto nasazení není přihlašování zapnuté, takže není co zobrazit.</p>
      </>
    );
  }

  const { userId, sessionId, redirectToSignIn } = await auth();
  if (!userId) return redirectToSignIn({ returnBackUrl: "/ucet" });

  const [user, usage] = await Promise.all([currentUser(), readUsage(userId)]);
  // Newest month first — the current month is what a visitor came to see.
  const months = Object.keys(usage.months).sort().reverse();
  const total = Object.values(usage.months).reduce((sum, count) => sum + count, 0);

  async function signOut() {
    "use server";
    if (sessionId) {
      const client = await clerkClient();
      await client.sessions.revokeSession(sessionId);
    }
    redirect("/");
  }

  return (
    <>
      <div style={{ display: "flex", alignItems: "baseline", gap: "1rem" }}>
        <h1 style={{ fontSize: "1.6rem", margin: 0 }}>Správa účtu</h1>
        <form action={signOut} style={{ marginLeft: "auto" }}>
          <button
            type="submit"
            style={{
              background: "none",
              border: "none",
              padding: 0,
              color: "#6b7280",
              fontSize: "0.85rem",
              textDecoration: "underline",
              cursor: "pointer",
              font: "inherit",
            }}
          >
            Odhlásit se
          </button>
        </form>
      </div>

      <div style={{ ...card, display: "flex", alignItems: "center", gap: "1rem" }}>
        {user?.imageUrl ? (
          // Loaded straight from Clerk; nothing about the picture is stored here.
          <img
            src={user.imageUrl}
            alt=""
            width={48}
            height={48}
            style={{ borderRadius: "50%", display: "block" }}
          />
        ) : null}
        <div style={{ display: "flex", gap: "2.5rem", flexWrap: "wrap" }}>
          {user?.fullName ? (
            <div>
              <p style={label}>Jméno</p>
              <strong>{user.fullName}</strong>
            </div>
          ) : null}
          <div>
            <p style={label}>Účet</p>
            <strong>{user?.primaryEmailAddress?.emailAddress ?? "—"}</strong>
          </div>
          {usage.since ? (
            <div>
              <p style={label}>Registrace</p>
              <strong>{new Date(usage.since).toLocaleDateString("cs-CZ")}</strong>
            </div>
          ) : null}
        </div>
      </div>

      <h2 style={{ fontSize: "1.1rem", marginTop: "2rem" }}>Využití nástrojů</h2>
      {months.length === 0 ? (
        <p style={{ color: "#6b7280" }}>
          Zatím tu není žádné volání. Přidejte si konektor podle{" "}
          <a href="/">návodu na hlavní stránce</a> a zeptejte se AI asistenta na cokoli právního.
        </p>
      ) : (
        <>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.95rem" }}>
            <thead>
              <tr style={{ textAlign: "left", color: "#6b7280", fontSize: "0.8rem" }}>
                <th style={{ padding: "0.4rem 0", fontWeight: 500 }}>Měsíc</th>
                <th style={{ padding: "0.4rem 0", fontWeight: 500, textAlign: "right" }}>
                  Počet volání
                </th>
              </tr>
            </thead>
            <tbody>
              {months.map((month) => (
                <tr key={month} style={{ borderTop: "1px solid #f3f4f6" }}>
                  <td style={{ padding: "0.45rem 0" }}>{monthName(month)}</td>
                  <td style={{ padding: "0.45rem 0", textAlign: "right" }}>
                    {usage.months[month].toLocaleString("cs-CZ")}
                  </td>
                </tr>
              ))}
              <tr style={{ borderTop: "1px solid #e5e7eb", fontWeight: 600 }}>
                <td style={{ padding: "0.45rem 0" }}>Celkem za zobrazené období</td>
                <td style={{ padding: "0.45rem 0", textAlign: "right" }}>
                  {total.toLocaleString("cs-CZ")}
                </td>
              </tr>
            </tbody>
          </table>
          <p style={{ marginTop: "0.75rem", fontSize: "0.78rem", color: "#9ca3af" }}>
            Jedno volání = jeden dotaz vašeho AI asistenta na server (vyhledání, načtení textu
            rozhodnutí či předpisu). Služba je zdarma a bez limitů - přehled je tu jen pro
            informaci. Uchovává se posledních dvanáct měsíců.
          </p>
        </>
      )}
    </>
  );
}
