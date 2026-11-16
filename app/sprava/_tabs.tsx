import Link from "next/link";
import { Icon, type IconName } from "../_icons";

/** The three parts of the admin area, as links (each is its own page). */
const TABS = [
  { id: "users", href: "/sprava", label: "Uživatelé", icon: "users" },
  { id: "texts", href: "/sprava/texty", label: "Texty", icon: "text" },
  { id: "system", href: "/sprava/system", label: "Systém", icon: "server" },
] as const satisfies ReadonlyArray<{ id: string; href: string; label: string; icon: IconName }>;

export function AdminTabs({ active }: { active: (typeof TABS)[number]["id"] }) {
  return (
    <nav className="adm-tabs" aria-label="Správa">
      {TABS.map((tab) => (
        <Link key={tab.id} href={tab.href} aria-current={tab.id === active ? "page" : undefined}>
          <Icon name={tab.icon} size={15} />
          <span>{tab.label}</span>
        </Link>
      ))}
    </nav>
  );
}
