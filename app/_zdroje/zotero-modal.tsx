"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { CONTACT } from "@/app/_legal";
import { ZOTERO_STAV, type ZoteroConnectionView, type ZoteroStatus, type ZoteroStav } from "@/src/zotero/web-types";
import { api } from "./api";
import { Confirm, Dialog } from "./dialog";
import { formatCount, formatDate, plural } from "./format";
import { ZIcon, type ZIconName } from "./icons";
import { closeZotero, dropZoteroStav, requestSignIn, useZdroje } from "./store";

/**
 * The Zotero modal, opened by ZdrojeModals (./modals.tsx) from ?zotero=1:
 * connect the user's zotero.org library (read-only) or see and remove the
 * connection. The routes are the contract in src/zotero/web-types.ts:
 *
 *   status      GET, JSON — loaded when the modal opens and after Odpojit
 *   connect     a real HTML form POST, not fetch: the server answers 303 to
 *               zotero.org's consent page, and the whole tab goes there
 *   disconnect  POST via api() (JSON)
 *
 * zotero.org and our callback send the user back to /?zotero=1&stav=<outcome>;
 * the modal keeps the outcome in a banner and drops &stav from the URL, so
 * a reload or a copied link does not announce it again.
 */

const STATUS_URL = "/api/zotero/status";
const CONNECT_URL = "/api/zotero/connect";
const DISCONNECT_URL = "/api/zotero/disconnect";
const KEYS_URL = "https://www.zotero.org/settings/keys";
const MAIL_ZOTERO = `mailto:${CONTACT}?subject=${encodeURIComponent("Dawmain - Zotero (Pro)")}`;

const BAD_ANSWER = "Server odpověděl nečekaně. Zkuste to prosím za chvíli.";

type Tone = "ok" | "info" | "bad";

/** One sentence per connect outcome; `pripojeno` is the only success, `zamitnuto` the user's own choice. */
export const STAV_BANNER: Record<ZoteroStav, { tone: Tone; text: string }> = {
  pripojeno: { tone: "ok", text: "Zotero je připojené. Asistent teď může hledat a číst ve vaší knihovně." },
  zamitnuto: { tone: "info", text: "Na stránce Zotera jste připojení nepotvrdili, nic se nezměnilo." },
  // web.ts: a missing or expired state cookie, one sealed for another account, or a token that does not match.
  vyprselo: {
    tone: "bad",
    text: "Připojování vypršelo nebo se přerušilo. Na potvrzení je 10 minut a dokončit ho jde jen v tomtéž prohlížeči a pod tímtéž účtem. Zkuste to prosím znovu.",
  },
  zapis: {
    tone: "bad",
    text: "Na stránce Zotera jste povolili i zápis. Takový klíč nepřijímám: neuložil jsem ho a požádal Zotero, aby ho zrušilo. Připojte Zotero znovu a zápis nepovolujte.",
  },
  prihlaseni: {
    tone: "bad",
    // Only "no session": another account than the one that started gets vyprselo (its state cookie does not open).
    text: "Připojení se nepodařilo dokončit, protože nejste přihlášeni. Přihlaste se a zkuste to znovu.",
  },
  nepro: { tone: "bad", text: "Zotero jde připojit jen v režimu Pro." },
  nedostupne: { tone: "bad", text: "Připojení Zotera není na tomto webu zapnuté." },
  limit: { tone: "bad", text: "Pokusů o připojení bylo teď příliš mnoho. Zkuste to prosím později." },
  // web.ts also answers chyba to a key without read access to the personal library (the user unticked it on zotero.org).
  chyba: {
    tone: "bad",
    text: "Připojení se nepodařilo dokončit - Zotero neodpovědělo, jak má, nebo klíč nesměl číst vaši knihovnu. Zkuste to prosím znovu a čtení knihovny na stránce Zotera nechte povolené.",
  },
};

function isStav(value: string | null): value is ZoteroStav {
  return value !== null && (ZOTERO_STAV as readonly string[]).includes(value);
}

/** The status route's answer, or null for anything else (an HTML error page, a proxy's JSON). */
function asStatus(body: unknown): ZoteroStatus | null {
  if (!body || typeof body !== "object") return null;
  const state = (body as { state?: unknown }).state;
  return state === "signed_out" || state === "ok" ? (body as ZoteroStatus) : null;
}

/** "od 12. 9. 2026", "od dneška", "od včerejška" — formatDate says "dnes" / "včera" for recent days. */
function since(iso: string): string {
  const date = formatDate(iso);
  if (date === "dnes") return "od dneška";
  if (date === "včera") return "od včerejška";
  return date ? `od ${date}` : "";
}

/** The key's group access in words: "všechny", "žádné", the names, or "3 skupiny" when Zotero did not name them. */
export function groupsText(connection: Pick<ZoteroConnectionView, "groups" | "groupNames">): string {
  const names = connection.groupNames?.filter((n) => n.trim() !== "") ?? null;
  if (connection.groups === "none") return "žádné";
  if (connection.groups === "all") {
    if (names === null) return "všechny";
    return names.length > 0 ? `všechny (${names.join(", ")})` : "všechny (zatím nejste členem žádné)";
  }
  if (names && names.length > 0) return names.join(", ");
  const n = connection.groups.length;
  return n === 0 ? "žádné" : `${formatCount(n)} ${plural(n, "skupina", "skupiny", "skupin")}`;
}

export function ZoteroModal({ stav }: { stav: string | null }) {
  const { auth } = useZdroje();
  const [status, setStatus] = useState<ZoteroStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [banner, setBanner] = useState<ZoteroStav | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  // Zkusit znovu: back to "Načítám…", so the click visibly does something.
  const refresh = useCallback(() => {
    setError(null);
    setReload((r) => r + 1);
  }, []);
  // After Odpojit the old status is stale: never show "Připojeno jako" again, not even when the
  // reload fails, and an old outcome ("Zotero je připojené") would contradict the panel too.
  // Focus goes to the panel before the confirmation that holds it unmounts, so it stays in the dialog.
  const changed = useCallback(() => {
    panel.current?.focus();
    setBanner(null);
    setStatus(null);
    setError(null);
    setReload((r) => r + 1);
  }, []);

  // The outcome of the connect flow: into the banner, out of the URL.
  useEffect(() => {
    if (stav === null) return;
    if (isStav(stav)) setBanner(stav);
    dropZoteroStav();
  }, [stav]);

  // Signed out (known from Clerk) or no Clerk at all: nothing to ask the server. Signing in
  // from here flips signed_out to signed_in and loads the status; loading → signed_in does not
  // load it twice (the first request already carried the session cookie).
  const authKey = auth === "signed_out" ? "out" : auth === "none" ? "none" : "in";
  useEffect(() => {
    if (authKey !== "in") return;
    const ctrl = new AbortController();
    void (async () => {
      try {
        const res = await api<unknown>(STATUS_URL, { signal: ctrl.signal });
        const body = res.ok ? asStatus(res.data) : null;
        if (body) {
          setStatus(body);
          setError(null);
        } else setError(res.ok ? BAD_ANSWER : res.error);
      } catch {
        // aborted
      }
    })();
    return () => ctrl.abort();
  }, [authKey, reload]);

  let body: ReactNode;
  if (authKey === "none") {
    body = <Notice icon="lock" title="Zotero tu teď připojit nejde" text="Připojení Zotera není na tomto webu zapnuté." />;
  } else if (authKey === "out" || status?.state === "signed_out") {
    body = (
      <Notice
        icon="library"
        title="Přihlaste se"
        text="Zotero se připojuje k vašemu účtu v Dawmainu. Asistent pak hledá a čte i ve vaší knihovně na zotero.org - jen čte, nic v ní nezmění."
      >
        <button type="button" className="zd-btn zd-btn-primary" onClick={requestSignIn}>
          Přihlásit se
        </button>
      </Notice>
    );
  } else if (!status) {
    body = error ? (
      <div className="zd-zotero-retry">
        <p className="zd-error" role="alert">
          {error}
        </p>
        <button type="button" className="zd-btn" onClick={refresh}>
          Zkusit znovu
        </button>
      </div>
    ) : (
      <p className="zd-progress" role="status">
        <span className="zd-spinner" aria-hidden="true" />
        Načítám…
      </p>
    );
  } else if (status.connection) {
    // Connected wins over the switches below: the user must still see the key and be able to remove it.
    body = (
      <Connected
        connection={status.connection}
        warning={
          !status.configured
            ? "Připojení Zotera je teď na tomto webu vypnuté, asistent do knihovny nevidí. Odpojit Zotero můžete dál."
            : !status.pro
              ? "Režim Pro teď nemáte, asistent do knihovny nevidí. Odpojit Zotero můžete dál."
              : null
        }
        onChanged={changed}
      />
    );
  } else if (!status.configured) {
    body = <Notice icon="lock" title="Zotero tu teď připojit nejde" text="Připojení Zotera není na tomto webu zapnuté. Oficiální databáze fungují dál." />;
  } else if (!status.pro) {
    body = (
      <Notice
        icon="lock"
        title="Zotero patří k režimu Pro"
        text="Stejně jako Vlastní zdroje je Zotero součástí režimu Pro. S ním asistent hledá a čte i ve vaší knihovně Zotero. Režim Pro přiděluji ručně a zdarma - napište mi, když ho chcete."
      >
        <a className="zd-btn zd-btn-primary" href={MAIL_ZOTERO}>
          Napsat o přístup
        </a>
      </Notice>
    );
  } else if (status.revoked) {
    const from = since(status.revoked.revokedAt);
    body = (
      <Reconnect
        title="Klíč přestal platit"
        who={`Zotero ${status.revoked.username}${from ? ` · neplatí ${from}` : ""}`}
        text="Klíč přestal platit (smazali jste ho v Zoteru?). Připojte Zotero znovu."
        forget="Odpojit Zotero úplně? Smažu i uložené jméno v Zoteru a čas, kdy klíč přestal platit."
        onChanged={changed}
      />
    );
  } else if (status.unreadable) {
    body = (
      <Reconnect
        title="Připojení je potřeba obnovit"
        who={`Zotero ${status.unreadable.username}`}
        text="Uložený klíč k Zoteru už neumím přečíst, změnilo se zabezpečení serveru. Připojte Zotero znovu. Starý klíč pak smažte v nastavení Zotera, já ho zrušit nemůžu."
        forget="Odpojit Zotero? Uložený klíč smažu; v Zoteru ho pak smažte sami."
        onChanged={changed}
      />
    );
  } else {
    body = <NotConnected />;
  }

  const shown = banner ? STAV_BANNER[banner] : null;
  return (
    <Dialog
      title="Zotero"
      subtitle="Vaše knihovna ze zotero.org, ve které asistent hledá a čte."
      size="narrow"
      onClose={closeZotero}
      footer={
        <button type="button" className="zd-btn zd-btn-primary zd-done" onClick={closeZotero}>
          Hotovo
        </button>
      }
    >
      <div className="zd-zotero" ref={panel} tabIndex={-1}>
        {/* Always in the DOM, so screen readers announce the banner when it appears. */}
        <div className="zd-zotero-live" aria-live="polite" aria-atomic="true">
          {shown ? (
            <p className="zd-banner zd-zotero-banner" data-tone={shown.tone}>
              <ZIcon name={shown.tone === "ok" ? "check" : "alert"} />
              <span>{shown.text}</span>
            </p>
          ) : null}
        </div>
        {status && error ? (
          <p className="zd-error" role="alert">
            {error}
          </p>
        ) : null}
        {body}
      </div>
    </Dialog>
  );
}

/** A centred panel (locked, signed out, not available) like the Vlastní zdroje notices. */
function Notice({ icon, title, text, children }: { icon: ZIconName; title: string; text: string; children?: ReactNode }) {
  return (
    <div className="zd-locked">
      <span className="zd-locked-icon" aria-hidden="true">
        <ZIcon name={icon} size={18} />
      </span>
      <h3>{title}</h3>
      <p>{text}</p>
      {children}
    </div>
  );
}

/**
 * "Připojit Zotero": a navigation to the connect route, which answers 303 to
 * zotero.org (never fetch — the consent page must open in this tab, and the
 * state cookie comes with that answer).
 */
function ConnectForm({ label = "Připojit Zotero", quiet = false }: { label?: string; quiet?: boolean }) {
  const [sent, setSent] = useState(false);
  useEffect(() => {
    // Back from zotero.org can restore this page from the back-forward cache, button still "sent".
    function onShow(event: PageTransitionEvent) {
      if (event.persisted) setSent(false);
    }
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);
  return (
    <form method="post" action={CONNECT_URL} className="zd-zotero-form" onSubmit={() => setSent(true)}>
      <button type="submit" className={quiet ? "zd-btn" : "zd-btn zd-btn-primary zd-btn-tall"} disabled={sent}>
        {sent ? "Přecházím na Zotero…" : label}
      </button>
    </form>
  );
}

/** What happens on zotero.org — said before the button, so the consent page is no surprise. */
function ConsentNote() {
  return (
    <p className="zd-zotero-note">
      Po kliknutí přejdete na zotero.org. Zotero se zeptá, jestli Dawmainu povolíte klíč ke čtení knihovny, poznámek a skupin. Rozsah tam můžete
      zúžit (poznámky, skupiny), čtení vaší knihovny ale nechte povolené. Zápis nepovolujte - klíč s právem zápisu Dawmain odmítne.
    </p>
  );
}

function LegalNote() {
  return (
    <p className="zd-zotero-note">
      Podrobnosti najdete v{" "}
      <a href="/soukromi" target="_blank" rel="noopener">
        zásadách ochrany osobních údajů
      </a>{" "}
      a v{" "}
      <a href="/podminky" target="_blank" rel="noopener">
        podmínkách užití
      </a>
      .
    </p>
  );
}

function NotConnected() {
  const headingId = useId();
  return (
    <>
      <section className="zd-zotero-section" aria-labelledby={headingId}>
        <h3 id={headingId}>Připojte svou knihovnu Zotero</h3>
        <p className="zd-intro">
          Asistent pak při rešerši hledá a čte i ve vaší knihovně na zotero.org, včetně skupin, kterých jste členem - vedle oficiálních databází a
          Vlastních zdrojů.
        </p>
      </section>
      <section className="zd-zotero-section">
        <h4 className="zd-section-name">Co Dawmain na dotaz asistenta přečte</h4>
        <ul className="zd-zotero-list">
          <li>
            <strong>záznamy</strong> - název, autoři, spisová značka a další údaje, štítky a kolekce,
          </li>
          <li>
            <strong>poznámky a anotace</strong>,
          </li>
          <li>
            <strong>text příloh</strong> - z indexu Zotera, a když tam chybí nebo je neúplný, z PDF v úložišti Zotera: to převedu na text a soubor hned
            zahodím.
          </li>
        </ul>
      </section>
      <ul className="zd-zotero-promises" aria-label="Na co se můžete spolehnout">
        <li>
          <ZIcon name="check" />
          <span>
            <strong>Jen čte.</strong> Ve vaší knihovně nic nezapíše, nezmění ani nesmaže.
          </span>
        </li>
        <li>
          <ZIcon name="check" />
          <span>Klíč k Zoteru ukládám zašifrovaný. Odpojit Zotero můžete kdykoli tady, klíč smazat i sami v nastavení Zotera.</span>
        </li>
        <li>
          <ZIcon name="check" />
          <span>Do knihovny se dostane jen asistent přihlášený vaším účtem, ne přes sdílený přístupový kód.</span>
        </li>
      </ul>
      <div className="zd-zotero-section zd-zotero-connect">
        <ConsentNote />
        <ConnectForm />
        <LegalNote />
      </div>
    </>
  );
}

function Connected({ connection, warning, onChanged }: { connection: ZoteroConnectionView; warning: string | null; onChanged: () => void }) {
  const headingId = useId();
  const narrowed = !connection.notes || connection.groups !== "all";
  const from = since(connection.connectedAt);
  return (
    <>
      <section className="zd-zotero-section" aria-labelledby={headingId}>
        <div className="zd-zotero-who">
          <span className="zd-zotero-mark" aria-hidden="true">
            <ZIcon name="library" />
          </span>
          <div className="zd-zotero-who-text">
            <h3 id={headingId}>
              Připojeno jako <span className="zd-zotero-user">{connection.username}</span>
            </h3>
            <p className="zd-muted zd-small">{from ? `${from} · jen ke čtení` : "jen ke čtení"}</p>
          </div>
        </div>
      </section>
      {warning ? <p className="zd-banner">{warning}</p> : null}
      <section className="zd-zotero-section">
        <h4 className="zd-section-name">Co klíč smí číst</h4>
        <dl className="zd-meta-list">
          <div>
            <dt>Vaše knihovna</dt>
            <dd>ano</dd>
          </div>
          <div>
            <dt>Poznámky</dt>
            <dd>{connection.notes ? "ano" : "ne"}</dd>
          </div>
          <div>
            <dt>Skupiny</dt>
            <dd>{groupsText(connection)}</dd>
          </div>
          <div>
            <dt>Zápis</dt>
            <dd>ne</dd>
          </div>
        </dl>
        {narrowed ? (
          <div className="zd-zotero-more">
            <p className="zd-zotero-note">Rozsah změníte tak, že Zotero připojíte znovu a na jeho stránce povolíte víc. Starý klíč pak smažu a požádám Zotero, aby ho zrušilo.</p>
            <ConnectForm label="Připojit znovu" quiet />
          </div>
        ) : null}
      </section>
      <section className="zd-zotero-section">
        <h4 className="zd-section-name">Odpojení</h4>
        <p className="zd-zotero-note">
          Odpojením klíč smažu a požádám Zotero, aby ho zrušilo. Ve vaší knihovně se nic nezmění. Klíč můžete smazat i sami v nastavení Zotera:{" "}
          <a href={KEYS_URL} target="_blank" rel="noopener noreferrer">
            zotero.org/settings/keys
          </a>
          .
        </p>
        <Disconnect question="Odpojit Zotero? Asistent pak do vaší knihovny neuvidí. Připojit ji můžete kdykoli znovu." onDone={onChanged} />
      </section>
      <LegalNote />
    </>
  );
}

/** Revoked or unreadable: why, the connect form again, and a way to remove the leftover record. */
function Reconnect({ title, who, text, forget, onChanged }: { title: string; who: string; text: string; forget: string; onChanged: () => void }) {
  const headingId = useId();
  return (
    <>
      <section className="zd-zotero-section" aria-labelledby={headingId}>
        <div className="zd-zotero-who">
          <span className="zd-zotero-mark" data-tone="bad" aria-hidden="true">
            <ZIcon name="alert" />
          </span>
          <div className="zd-zotero-who-text">
            <h3 id={headingId}>{title}</h3>
            <p className="zd-muted zd-small">{who}</p>
          </div>
        </div>
        <p className="zd-intro">{text}</p>
      </section>
      <div className="zd-zotero-section zd-zotero-connect">
        <ConsentNote />
        <ConnectForm />
        <p className="zd-zotero-note">
          Staré klíče najdete v{" "}
          <a href={KEYS_URL} target="_blank" rel="noopener noreferrer">
            nastavení Zotera
          </a>
          .
        </p>
      </div>
      <Disconnect question={forget} onDone={onChanged} quiet />
    </>
  );
}

/** "Odpojit" behind an inline confirmation; POST disconnect, then the parent reloads the status. */
function Disconnect({ question, onDone, quiet = false }: { question: string; onDone: () => void; quiet?: boolean }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [refocus, setRefocus] = useState(false);
  // Zrušit (or Escape, or a failed request) unmounts the confirmation that held focus: back to Odpojit.
  const cancel = useCallback(() => {
    setConfirming(false);
    setRefocus(true);
  }, []);
  useEffect(() => {
    if (!refocus || confirming) return;
    setRefocus(false);
    trigger.current?.focus();
  }, [refocus, confirming]);

  async function disconnect() {
    setBusy(true);
    setError(null);
    const res = await api<{ ok: true }>(DISCONNECT_URL, { method: "POST" });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      cancel();
      return;
    }
    // Success: the parent moves focus into the panel and swaps this section out.
    onDone();
  }

  return (
    <div className="zd-zotero-disconnect">
      {confirming ? (
        <Confirm question={question} confirmLabel="Odpojit" busy={busy} onConfirm={() => void disconnect()} onCancel={cancel} />
      ) : (
        <button ref={trigger} type="button" className={quiet ? "zd-btn zd-btn-quiet" : "zd-btn"} onClick={() => setConfirming(true)}>
          Odpojit
        </button>
      )}
      {error ? (
        <p className="zd-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
