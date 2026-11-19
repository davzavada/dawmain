"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type MouseEvent } from "react";
import { Icon, type IconName } from "./_icons";
import { setPlatform, usePlatform, type PlatformId } from "./_platform";
import { LibraryMark } from "./_zdroje/library-mark";
import { useZdroje } from "./_zdroje/store";

/**
 * Site navigation: a sticky sidebar on wide screens, a sticky tab strip on
 * narrow ones (globals.css shows one or the other). On the home page the
 * entry for the section in view is highlighted as you scroll.
 */

const SECTIONS: Array<{ id: string; label: string; short: string; icon: IconName }> = [
  { id: "uvod", label: "Úvod", short: "Úvod", icon: "sparkles" },
  { id: "zdroje", label: "Zdroje", short: "Zdroje", icon: "list" },
  { id: "pripojeni", label: "Jak se připojit", short: "Připojení", icon: "sliders" },
];

const GUIDES: Array<{ id: PlatformId; label: string }> = [
  { id: "claude", label: "Claude" },
  { id: "chatgpt", label: "ChatGPT" },
];

const LEGAL: Array<{ href: string; label: string; icon: IconName }> = [
  { href: "/podminky", label: "Podmínky užití", icon: "book" },
  { href: "/soukromi", label: "Ochrana osobních údajů", icon: "lock" },
];

/** A section counts as "in view" once its top passes this line. */
const SPY_OFFSET = 140;

function useActiveSection(enabled: boolean): string | null {
  const [active, setActive] = useState<string>(SECTIONS[0].id);

  useEffect(() => {
    if (!enabled) return;
    function update() {
      let current = SECTIONS[0].id;
      for (const { id } of SECTIONS) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top <= SPY_OFFSET) current = id;
      }
      // The last section may be too short to ever reach the line.
      if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 4) {
        current = SECTIONS[SECTIONS.length - 1].id;
      }
      setActive(current);
    }
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [enabled]);

  return enabled ? active : null;
}

/**
 * "Moje zdroje": the signed-in user's own sources, each a page of its own —
 * Osobní soubory (/soubory), one entry per team library the user is a
 * member of, named after the team (/soubory/<handle>, with the team's logo
 * or initials). Zotero is in the account menu (app/_zdroje/account.tsx).
 */
function OwnSourcesNav({ pathname }: { pathname: string }) {
  const { auth, summary } = useZdroje();
  // Until Clerk loads: the group as the sign-in hint expects it (CSS shows it only to the remembered signed-in), counts shimmering.
  if (auth === "loading") {
    return (
      <div className="nav-group zd-hint-in">
        <span className="nav-heading">Moje zdroje</span>
        <Link href="/soubory" className="nav-item">
          <Icon name="book" />
          <span>Osobní soubory</span>
          <span className="nav-count zd-shimmer zd-shimmer-late nav-count-shimmer" aria-hidden="true" />
        </Link>
      </div>
    );
  }
  if (auth !== "signed_in") return null;
  const loading = summary === null;
  const libraries = summary?.state === "ok" ? summary.libraries : [];
  const personal = libraries.find((l) => l.kind === "user");
  const teams = libraries.filter((l) => l.kind === "org");
  const current = (href: string) => (pathname === href ? { "aria-current": "page" as const } : {});
  return (
    <>
      <div className="nav-group">
        <span className="nav-heading">Moje zdroje</span>
        <Link href="/soubory" className="nav-item" {...current("/soubory")}>
          <Icon name="book" />
          <span>Osobní soubory</span>
          {personal?.counts ? (
            <span className="nav-count">{personal.counts.total}</span>
          ) : loading ? (
            <span className="nav-count zd-shimmer zd-shimmer-late nav-count-shimmer" aria-hidden="true" />
          ) : null}
        </Link>
        {teams.map((team) => {
          const href = `/soubory/${encodeURIComponent(team.handle)}`;
          return (
            <Link key={team.id} href={href} className="nav-item nav-in" data-off={!team.pro || undefined} {...current(href)}>
              <LibraryMark lib={team} size={18} />
              <span className="nav-label">{team.name}</span>
              {team.counts ? <span className="nav-count">{team.counts.total}</span> : null}
            </Link>
          );
        })}
      </div>
    </>
  );
}

/** The same entries in the strip under the header, which replaces the sidebar on narrow screens. */
function OwnSourcesTabs({ pathname }: { pathname: string }) {
  const { auth, summary } = useZdroje();
  if (auth === "loading") {
    return (
      <span className="zd-hint-in tab-hinted">
        <span className="tab-sep" aria-hidden="true" />
        <Link href="/soubory" className="tab-item">
          Soubory
        </Link>
      </span>
    );
  }
  if (auth !== "signed_in") return null;
  const teams = summary?.state === "ok" ? summary.libraries.filter((l) => l.kind === "org") : [];
  const current = (href: string) => (pathname === href ? { "aria-current": "page" as const } : {});
  return (
    <>
      <span className="tab-sep" aria-hidden="true" />
      <Link href="/soubory" className="tab-item" {...current("/soubory")}>
        Soubory
      </Link>
      {teams.map((team) => {
        const href = `/soubory/${encodeURIComponent(team.handle)}`;
        return (
          <Link key={team.id} href={href} className="tab-item nav-in" data-off={!team.pro || undefined} {...current(href)}>
            <LibraryMark lib={team} size={16} />
            {team.name}
          </Link>
        );
      })}
    </>
  );
}

export function SiteNav({ sourceCount }: { sourceCount: number }) {
  const pathname = usePathname();
  const home = pathname === "/";
  const active = useActiveSection(home);
  const platform = usePlatform();

  function openGuide(id: PlatformId) {
    return (event: MouseEvent) => {
      // Elsewhere the link navigates home and the guide reads the hash.
      if (!home) return;
      event.preventDefault();
      setPlatform(id);
      document.getElementById("pripojeni")?.scrollIntoView({ behavior: "smooth" });
    };
  }

  const current = (on: boolean) => (on ? { "aria-current": "location" as const } : {});

  return (
    <>
      <nav className="sidebar" aria-label="Navigace na stránce">
        <div className="nav-group">
          {SECTIONS.map(({ id, label, icon }) => (
            <Link key={id} href={`/#${id}`} className="nav-item" {...current(active === id)}>
              <Icon name={icon} />
              <span>{label}</span>
              {id === "zdroje" && <span className="nav-count">{sourceCount}</span>}
            </Link>
          ))}
        </div>

        <OwnSourcesNav pathname={pathname} />

        <div className="nav-group">
          <span className="nav-heading">Návod pro</span>
          {GUIDES.map(({ id, label }) => (
            <Link
              key={id}
              href={`/#${id}`}
              onClick={openGuide(id)}
              className="nav-item guide-item"
              data-selected={platform === id}
            >
              <span className="nav-dot" aria-hidden="true" />
              <span>{label}</span>
            </Link>
          ))}
        </div>

        <div className="nav-group nav-legal">
          {LEGAL.map(({ href, label, icon }) => (
            <Link key={href} href={href} className="nav-item" {...current(pathname === href)}>
              <Icon name={icon} />
              <span>{label}</span>
            </Link>
          ))}
        </div>
      </nav>

      <div className="topbar">
        <nav aria-label="Navigace na stránce">
          {SECTIONS.map(({ id, short }) => (
            <Link key={id} href={`/#${id}`} className="tab-item" {...current(active === id)}>
              {short}
            </Link>
          ))}
          <OwnSourcesTabs pathname={pathname} />
        </nav>
      </div>
    </>
  );
}
