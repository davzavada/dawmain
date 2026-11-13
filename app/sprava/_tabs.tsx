import Link from "next/link";

/** The two halves of the admin area, as links (each is its own page). */
const TABS = [
  { id: "users", href: "/sprava", label: "Uživatelé" },
  { id: "texts", href: "/sprava/texty", label: "Texty" },
] as const;

export function AdminTabs({ active }: { active: (typeof TABS)[number]["id"] }) {
  return (
    <nav className="adm-tabs" aria-label="Správa">
      {TABS.map((tab) => (
        <Link key={tab.id} href={tab.href} aria-current={tab.id === active ? "page" : undefined}>
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
