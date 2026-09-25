"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type MouseEvent } from "react";
import { Icon, type IconName } from "./_icons";
import { setPlatform, usePlatform, type PlatformId } from "./_platform";

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
          <span className="nav-item locked" aria-disabled="true" title="Dostupné v placené verzi">
            <Icon name="upload" />
            <span className="nav-ellipsis">Nahrát vlastní zdroje</span>
            <Icon name="lock" size={13} label="zamčeno" className="nav-lock" />
          </span>
        </div>

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
          <span
            className="tab-item locked"
            aria-disabled="true"
            title="Nahrát vlastní zdroje – v placené verzi"
          >
            <span>Vlastní zdroje</span>
            <Icon name="lock" size={13} label="zamčeno" />
          </span>
        </nav>
      </div>
    </>
  );
}
