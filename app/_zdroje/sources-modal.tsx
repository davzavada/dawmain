"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { CONTACT } from "@/app/_legal";
import { TERMS_VERSION, UUID_RE } from "@/src/files/config";
import type { LibrarySummary } from "@/src/files/web-types";
import { api } from "./api";
import { DocumentPanel } from "./detail";
import { Dialog } from "./dialog";
import { countDocuments, countMembers, quotaLine, quotaShare } from "./format";
import { ZIcon } from "./icons";
import { InvitationActions, InvitationText, useInvitations } from "./invitations";
import { DocumentList, useDocumentList } from "./list";
import { closeSources, refreshSummary, requestSignIn, showInSources, useZdroje, type SourcesTab } from "./store";
import { TeamModal } from "./team-modal";
import { Uploader } from "./upload";

/**
 * The Vlastní zdroje modal (design 2b–2e) and the team modal (3d, 3f),
 * mounted once in the root layout and driven by the URL: ?zdroje=moje|tym
 * (+ &dokument=<id> for a document's detail), ?tym=<org id>. Deep links and
 * the old /vlastni-zdroje route (which redirects here) open them; closing
 * removes the parameter.
 */
export function ZdrojeModals() {
  const params = useSearchParams();
  const tab = params.get("zdroje");
  const team = params.get("tym");
  const doc = params.get("dokument");
  return (
    <>
      {tab ? <SourcesModal tab={tab === "tym" ? "tym" : "moje"} documentId={doc && UUID_RE.test(doc) ? doc.toLowerCase() : null} /> : null}
      {team && !tab ? <TeamModal orgParam={team} /> : null}
    </>
  );
}

const MAIL_PRO = `mailto:${CONTACT}?subject=${encodeURIComponent("Dawmain - Vlastní zdroje (Pro)")}`;
const MAIL_TEAM = `mailto:${CONTACT}?subject=${encodeURIComponent("Dawmain - týmový přístup")}`;

function SourcesModal({ tab, documentId }: { tab: SourcesTab; documentId: string | null }) {
  const { auth, summary, failed } = useZdroje();
  const [teamId, setTeamId] = useState<string | null>(null);
  const [replace, setReplace] = useState<{ id: string; title: string; libraryId: string } | null>(null);
  const [listKey, setListKey] = useState(0);

  const libraries = summary?.state === "ok" ? summary.libraries : [];
  const personal = libraries.find((l) => l.kind === "user") ?? null;
  const teams = libraries.filter((l) => l.kind === "org");
  const team = teams.find((t) => t.id === teamId) ?? teams.find((t) => t.pro) ?? teams[0] ?? null;
  const selected = tab === "tym" ? team : personal;
  const mode = summary?.state === "ok" ? summary.mode : "off";

  const subtitle = "Dokumenty, ve kterých asistent hledá vedle oficiálních databází.";
  const footer = (
    <>
      {selected?.pro && selected.counts && selected.pagesUsed !== null ? (
        <span className="zd-quota">
          <span className="zd-quota-bar" aria-hidden="true">
            <span style={{ width: `${quotaShare(selected.pagesUsed, selected.quotaPages) * 100}%` }} />
          </span>
          <span className="zd-quota-text">{quotaLine(selected.counts.total, selected.pagesUsed, selected.quotaPages)}</span>
        </span>
      ) : null}
      <button type="button" className="zd-btn zd-btn-primary zd-done" onClick={closeSources}>
        Hotovo
      </button>
    </>
  );

  let body: ReactNode;
  if (auth === "none") {
    body = <Notice title="Vlastní zdroje tu nejsou k dispozici" text="Na tomto nasazení není zapnuté přihlašování." />;
  } else if (auth === "signed_out") {
    body = (
      <Notice title="Přihlaste se" text="Vlastní zdroje patří k vašemu účtu. Po přihlášení je uvidíte tady.">
        <button type="button" className="zd-btn zd-btn-primary" onClick={requestSignIn}>
          Přihlásit se
        </button>
      </Notice>
    );
  } else if (!summary) {
    body = failed ? (
      <Notice title="Vlastní zdroje se nepodařilo načíst" text="Zkuste to prosím za chvíli.">
        <button type="button" className="zd-btn zd-btn-secondary" onClick={() => void refreshSummary()}>
          Zkusit znovu
        </button>
      </Notice>
    ) : (
      <p className="zd-progress zd-pad" role="status">
        <span className="zd-spinner" aria-hidden="true" />
        Načítám…
      </p>
    );
  } else if (summary.state === "unavailable") {
    body = <Notice title="Vlastní zdroje jsou teď vypnuté" text="Oficiální databáze fungují dál. Zkuste to prosím později." />;
  } else if (summary.state === "signed_out") {
    body = <Notice title="Přihlaste se" text="Vlastní zdroje patří k vašemu účtu." />;
  } else {
    const panel =
      tab === "moje" ? (
        personal ? (
          <LibraryPanel
            key={personal.id}
            lib={personal}
            mode={mode}
            termsAccepted={summary.termsAccepted}
            documentId={documentId}
            replace={replace?.libraryId === personal.id ? replace : null}
            setReplace={setReplace}
            listKey={listKey}
            bumpList={() => setListKey((k) => k + 1)}
            tab="moje"
          />
        ) : null
      ) : team ? (
        <LibraryPanel
          key={team.id}
          lib={team}
          mode={mode}
          termsAccepted={summary.termsAccepted}
          documentId={documentId}
          replace={replace?.libraryId === team.id ? replace : null}
          setReplace={setReplace}
          listKey={listKey}
          bumpList={() => setListKey((k) => k + 1)}
          tab="tym"
          teamPicker={teams.length > 1 ? { teams, onPick: setTeamId } : null}
        />
      ) : (
        <TeamLocked />
      );
    body = (
      <div className="zd-body">
        <nav className="zd-rail" aria-label="Knihovny">
          <RailItem on={tab === "moje"} title="Moje zdroje" sub={personal?.pro ? countDocuments(personal.counts?.total ?? 0) : "Jen s Pro"} locked={!personal?.pro} onClick={() => showInSources("moje", null)} />
          {teams.length === 0 ? (
            <RailItem on={tab === "tym"} title="Týmové zdroje" sub="Jen pro tým" locked onClick={() => showInSources("tym", null)} />
          ) : (
            teams.map((t) => (
              <RailItem
                key={t.id}
                on={tab === "tym" && team?.id === t.id}
                title={teams.length > 1 ? t.name : "Týmové zdroje"}
                sub={t.pro ? countDocuments(t.counts?.total ?? 0) : "Bez Pro"}
                locked={!t.pro}
                onClick={() => {
                  setTeamId(t.id);
                  showInSources("tym", null);
                }}
              />
            ))
          )}
        </nav>
        <div className="zd-segmented-wrap">
          <div className="zd-segmented" role="tablist" aria-label="Knihovny">
            <button type="button" role="tab" aria-selected={tab === "moje"} onClick={() => showInSources("moje", null)}>
              Moje
            </button>
            <button type="button" role="tab" aria-selected={tab === "tym"} onClick={() => showInSources("tym", null)}>
              Týmové
            </button>
          </div>
        </div>
        <div className="zd-panel">{panel}</div>
      </div>
    );
  }

  return (
    <Dialog title="Vlastní zdroje" subtitle={subtitle} onClose={closeSources} footer={footer}>
      {body}
    </Dialog>
  );
}

function RailItem({ on, title, sub, locked, onClick }: { on: boolean; title: string; sub: string; locked?: boolean; onClick: () => void }) {
  return (
    <button type="button" className="zd-rail-item" aria-current={on ? "true" : undefined} onClick={onClick}>
      <span className="zd-rail-title">
        {title}
        {locked ? <ZIcon name="lock" size={13} className="zd-rail-lock" /> : null}
      </span>
      <span className="zd-rail-sub">{sub}</span>
    </button>
  );
}

function Notice({ title, text, children }: { title: string; text: string; children?: ReactNode }) {
  return (
    <div className="zd-locked">
      <span className="zd-locked-icon" aria-hidden="true">
        <ZIcon name="lock" size={18} />
      </span>
      <h3>{title}</h3>
      <p>{text}</p>
      {children}
    </div>
  );
}

/** 2c / 3b: the team tab for someone in no team — with their pending invitations, if any. */
function TeamLocked() {
  const invites = useInvitations();
  return (
    <div className="zd-locked">
      <span className="zd-locked-icon" aria-hidden="true">
        <ZIcon name="lock" size={18} />
      </span>
      <h3>Týmové zdroje jsou jen pro členy týmu</h3>
      <p>Kancelář tu sdílí vzory, metodiky a interní rešerše. Asistent v nich pak hledá u všech členů. Do týmu vás přidá jeho správce.</p>
      {invites.invitations.length > 0 ? (
        invites.invitations.map((invitation) => (
          <div key={invitation.id} className="zd-invite-box">
            <p>
              Máte pozvánku: <InvitationText invitation={invitation} />
            </p>
            <InvitationActions invitation={invitation} api={invites} />
          </div>
        ))
      ) : (
        <a className="zd-btn zd-btn-primary" href={MAIL_TEAM}>
          Napsat o týmový přístup
        </a>
      )}
    </div>
  );
}

function LibraryPanel({
  lib,
  mode,
  termsAccepted,
  documentId,
  replace,
  setReplace,
  listKey,
  bumpList,
  tab,
  teamPicker,
}: {
  lib: LibrarySummary;
  mode: string;
  termsAccepted: boolean;
  documentId: string | null;
  replace: { id: string; title: string; libraryId: string } | null;
  setReplace: (r: { id: string; title: string; libraryId: string } | null) => void;
  listKey: number;
  bumpList: () => void;
  tab: SourcesTab;
  teamPicker?: { teams: LibrarySummary[]; onPick: (id: string) => void } | null;
}) {
  const { documents, setDocuments, total, error, reload } = useDocumentList(lib.id, listKey);
  const readonly = mode !== "on";
  const team = lib.kind === "org";

  if (documentId) {
    return (
      <DocumentPanel
        id={documentId}
        readonly={readonly}
        team={team}
        onBack={() => showInSources(tab, null)}
        onReupload={(doc) => {
          setReplace(doc);
          showInSources(tab, null);
        }}
        onDeleted={() => {
          bumpList();
          showInSources(tab, null);
        }}
      />
    );
  }

  const hasDocs = (documents?.length ?? 0) > 0;
  if (!lib.pro && !hasDocs) {
    if (documents === null && !error) {
      return (
        <p className="zd-progress" role="status">
          <span className="zd-spinner" aria-hidden="true" />
          Načítám…
        </p>
      );
    }
    return team ? (
      <div className="zd-locked">
        <span className="zd-locked-icon" aria-hidden="true">
          <ZIcon name="lock" size={18} />
        </span>
        <h3>Tým {lib.name} zatím Vlastní zdroje nemá</h3>
        <p>Týmové zdroje přiděluji ručně a zdarma. Napište mi, pro jaký tým je chcete.</p>
        <a className="zd-btn zd-btn-primary" href={MAIL_TEAM}>
          Napsat o týmový přístup
        </a>
      </div>
    ) : (
      <div className="zd-locked">
        <span className="zd-locked-icon" aria-hidden="true">
          <ZIcon name="lock" size={18} />
        </span>
        <h3>Vlastní zdroje přiděluji ručně a zdarma</h3>
        <p>Nahrajete knihy, články, komentáře a vzory; převedou se na text přímo ve vašem prohlížeči. Asistent v nich pak hledá vedle oficiálních databází.</p>
        <a className="zd-btn zd-btn-primary" href={MAIL_PRO}>
          Napsat o přístup
        </a>
      </div>
    );
  }

  return (
    <div className="zd-library">
      {teamPicker ? (
        <label className="zd-field zd-team-picker">
          <span>Tým</span>
          <select value={lib.id} onChange={(e) => teamPicker.onPick(e.target.value)}>
            {teamPicker.teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {team ? (
        <div className="zd-banner zd-banner-info">
          <ZIcon name="users" />
          <span>
            <strong>{lib.name}</strong>
            {lib.memberCount !== null ? ` · ${countMembers(lib.memberCount)}` : ""}. Co sem nahrajete, uvidí celý tým.
          </span>
        </div>
      ) : null}
      <p className="zd-intro">
        {team
          ? "Dokumenty sdílené celým týmem. Asistent v nich hledá u všech členů; vypnutý dokument přeskočí."
          : "Asistent v nich hledá vedle oficiálních databází. Vidíte je jen vy. Vypnutý dokument asistent přeskočí."}
      </p>
      {!lib.pro ? (
        <p className="zd-banner">Režim Pro tu už není aktivní. Dokumenty můžete prohlížet a mazat, nové nahrát nejde.</p>
      ) : mode === "readonly" ? (
        <p className="zd-banner">Vlastní zdroje jsou teď jen pro čtení: hledat, číst a mazat jde, nahrávat ne. Zkuste to později.</p>
      ) : mode === "off" ? (
        <p className="zd-banner">Vlastní zdroje jsou teď dočasně vypnuté. Mazat dokumenty jde dál.</p>
      ) : null}
      {lib.pro && lib.canUpload && mode === "on" ? (
        termsAccepted ? (
          <Uploader
            library={lib}
            replace={replace}
            onCancelReplace={() => setReplace(null)}
            onUploaded={() => {
              setReplace(null);
              reload();
              void refreshSummary();
            }}
          />
        ) : (
          <TermsGate />
        )
      ) : null}
      {error ? (
        <p className="zd-error" role="alert">
          {error}
        </p>
      ) : documents ? (
        <DocumentList
          documents={documents}
          total={total}
          team={team}
          readonly={readonly}
          onOpen={(id) => showInSources(tab, id)}
          onChanged={reload}
          setDocuments={setDocuments}
        />
      ) : (
        <p className="zd-progress" role="status">
          <span className="zd-spinner" aria-hidden="true" />
          Načítám dokumenty…
        </p>
      )}
    </div>
  );
}

/** Before the first upload: the content rules in short, and consent. */
function TermsGate() {
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setError(null), [checked]);

  async function accept() {
    setBusy(true);
    const res = await api("/api/files/terms", { method: "POST", json: { accept: true, version: TERMS_VERSION } });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    await refreshSummary();
  }

  return (
    <section className="zd-card zd-terms" aria-label="Pravidla Vlastních zdrojů">
      <strong>Než nahrajete první dokument</strong>
      <ul>
        <li>Nahrávejte jen texty, které máte právo si takto uložit — a v týmu sdílet. Licencované databáze (beck-online, ASPI, Codexis) budování vlastní databáze obvykle zakazují.</li>
        <li>Nepatří sem spisy a dokumenty klientů, neveřejné osobní údaje, zvláštní kategorie osobních údajů ani cizí obchodní tajemství. Vzory nejdřív anonymizujte.</li>
        <li>Na server jde jen převedený text, originál zůstává u vás. Záloha není.</li>
        <li>Metadata navrhne AI — zkontrolujete je a potvrdíte. Vlastní dokument není oficiální zdroj: citace ověřte v tištěném vydání.</li>
      </ul>
      <label className="zd-check">
        <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
        <span>
          Souhlasím s pravidly Vlastních zdrojů v{" "}
          <a href="/podminky" target="_blank" rel="noopener">
            Podmínkách užití
          </a>
          .
        </span>
      </label>
      {error ? (
        <p className="zd-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="zd-card-actions">
        <button type="button" className="zd-btn zd-btn-primary" disabled={!checked || busy} onClick={() => void accept()}>
          {busy ? "Ukládám…" : "Pokračovat"}
        </button>
      </div>
    </section>
  );
}
