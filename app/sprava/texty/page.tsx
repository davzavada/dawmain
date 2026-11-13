import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/src/admin/server";
import { loadSiteTexts } from "@/src/content/store";
import { AdminTabs } from "../_tabs";
import { TextEditor } from "./editor";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Texty · Správa · Dawmain", robots: { index: false, follow: false } };

/**
 * The text editor of the admin area: the wording of the home page's intro,
 * of the lines under the Pro sources and of the two legal pages
 * (src/content/texts.ts). Admins only — anyone else gets the same 404 as a
 * page that does not exist. Every save goes through saveTextAction.
 */
export default async function AdminTextsPage() {
  const me = await requireAdmin();
  if (!me) notFound();
  const { overrides, available } = await loadSiteTexts();

  return (
    <div className="adm">
      <Link href="/" className="back">
        ← Hlavní stránka
      </Link>
      <header className="adm-head">
        <h1>Správa</h1>
        <p className="muted">Texty na webu: úvod hlavní stránky, popisky zdrojů, podmínky a zásady.</p>
      </header>
      <AdminTabs active="texts" />
      {available ? null : (
        <p className="zd-error">
          Databáze teď není dostupná (nebo není nastavená), takže web ukazuje výchozí texty a uložit tu nic nejde. Zkus stránku obnovit za chvíli.
        </p>
      )}
      <TextEditor overrides={overrides} available={available} />
      <p className="muted small adm-foot">
        Uložený text se na webu projeví při příští návštěvě stránky. Seznam zdrojů, návod k připojení a tlačítka se tu neupravují, ty jsou součástí kódu.
        Výchozí znění je uložené v repozitáři (<code>src/content/texts.ts</code>) a web se k němu vrátí, kdykoli databáze neodpoví.
      </p>
    </div>
  );
}
