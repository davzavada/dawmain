"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { CONTACT } from "@/app/_legal";
import { ZOTERO_STAV, type ZoteroConnectionView, type ZoteroModeView, type ZoteroStatus, type ZoteroStav } from "@/src/zotero/web-types";
import { api } from "./api";
import { Confirm, Dialog } from "./dialog";
import { formatDate } from "./format";
import { ZIcon, type ZIconName } from "./icons";
import { closeZotero, dropZoteroStav, requestSignIn, useZdroje } from "./store";
import { asStatus, notifyZoteroChanged, STATUS_URL } from "./zotero-status";

/**
 * The Zotero modal, opened by ZdrojeModals (./modals.tsx) from ?zotero=1:
 * connect the user's zotero.org library — choosing first what Dawmain may do
 * there ("Jen číst" or "Číst a ukládat") — or see, reconnect and remove the
 * connection. The routes are the contract in src/zotero/web-types.ts:
 *
 *   status      GET, JSON — loaded when the modal opens and after Odpojit
 *   connect     a real HTML form POST (mode=read|write from the radio
 *               cards), not fetch: the server answers 303 to zotero.org's
 *               consent page, and the whole tab goes there
 *   disconnect  POST via api() (JSON)
 *
 * zotero.org and our callback send the user back to /?zotero=1&stav=<outcome>;
 * the modal keeps the outcome in a banner and drops &stav from the URL, so
 * a reload or a copied link does not announce it again.
 */

const CONNECT_URL = "/api/zotero/connect";
const DISCONNECT_URL = "/api/zotero/disconnect";
const MAIL_ZOTERO = `mailto:${CONTACT}?subject=${encodeURIComponent("Dawmain - Zotero (Pro)")}`;

const BAD_ANSWER = "Server odpověděl nečekaně. Zkuste to prosím za chvíli.";

type Tone = "ok" | "info" | "bad";

/**
 * One sentence per connect outcome; `pripojeno` is the only success (its
 * text here is the "write" one — bannerText picks PRIPOJENO_READ for a
 * read-only connection), `zamitnuto` the user's own choice.
 */
export const STAV_BANNER: Record<ZoteroStav, { tone: Tone; text: string }> = {
  pripojeno: {
    tone: "ok",
    text: "Zotero je připojené. Asistent teď může hledat a číst ve vaší knihovně a ukládat do ní nalezené dokumenty.",
  },
  zamitnuto: { tone: "info", text: "Na stránce Zotera jste připojení nepotvrdili, nic se nezměnilo." },
  // web.ts: a missing or expired state cookie, one sealed for another account, or a token that does not match.
  vyprselo: {
    tone: "bad",
    text: "Připojování vypršelo nebo se přerušilo. Na potvrzení je 10 minut a dokončit ho jde jen v tomtéž prohlížeči a pod tímtéž účtem. Zkuste to prosím znovu.",
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

/** `pripojeno` for a connection that may only read (chosen so, or the key on zotero.org did not allow writing). */
export const PRIPOJENO_READ = "Zotero je připojené. Asistent teď může hledat a číst ve vaší knihovně.";

/** The banner's sentence: `pripojeno` follows the connection's effective mode. */
export function bannerText(stav: ZoteroStav, mode: ZoteroModeView | null): string {
  return stav === "pripojeno" && mode !== "write" ? PRIPOJENO_READ : STAV_BANNER[stav].text;
}

/** What the user may let Dawmain do, as the radio cards say it ("write" preselected by design). */
const MODES: ReadonlyArray<{ value: ZoteroModeView; title: string; text: string }> = [
  { value: "read", title: "Jen číst", text: "Asistent v knihovně hledá a čte. Nic v ní nezapíše, nezmění ani nesmaže." },
  { value: "write", title: "Číst a ukládat", text: "Asistent může i rovnou do Zotera ukládat nalezené dokumenty." },
];

/** The second line under "Připojeno jako": "od dneška · čtení a ukládání". */
export function modeText(mode: ZoteroModeView): string {
  return mode === "write" ? "čtení a ukládání" : "jen čtení";
}

function isStav(value: string | null): value is ZoteroStav {
  return value !== null && (ZOTERO_STAV as readonly string[]).includes(value);
}

/** "od 12. 9. 2026", "od dneška", "od včerejška" — formatDate says "dnes" / "včera" for recent days. */
function since(iso: string): string {
  const date = formatDate(iso);
  if (date === "dnes") return "od dneška";
  if (date === "včera") return "od včerejška";
  return date ? `od ${date}` : "";
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
    // The home page row (./own-sources.tsx) must not keep showing the old connection.
    notifyZoteroChanged();
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
        text="Zotero se připojuje k vašemu účtu v Dawmainu. Asistent pak hledá a čte i ve vaší knihovně na zotero.org, a když mu to povolíte, ukládá do ní nalezené dokumenty."
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
      />
    );
  } else if (status.unreadable) {
    body = (
      <Reconnect
        title="Připojení je potřeba obnovit"
        who={`Zotero ${status.unreadable.username}`}
        text="Uložený klíč k Zoteru už neumím přečíst, změnilo se zabezpečení serveru. Připojte Zotero znovu. Starý klíč pak smažte v nastavení Zotera, já ho zrušit nemůžu."
      />
    );
  } else {
    body = <NotConnected />;
  }

  // "Připojeno" waits for the status: its sentence depends on the mode the connection got.
  const mode = status?.state === "ok" ? (status.connection?.mode ?? null) : null;
  const shown = banner && (banner !== "pripojeno" || status) ? { tone: STAV_BANNER[banner].tone, text: bannerText(banner, mode) } : null;
  return (
    <Dialog
      title="Zotero"
      subtitle="Vaše knihovna ze zotero.org, ve které asistent hledá, čte a případně ukládá."
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
              {shown.tone === "ok" ? <ZIcon name="check" /> : <Glyph mark={shown.tone === "bad" ? "!" : "i"} />}
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

/** A round "!" or "i" mark (the error and info banners, the invalid-key row): 24×24 grid like ZIcon. */
function Glyph({ mark, size = 16 }: { mark: "!" | "i"; size?: number }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <path d={mark === "!" ? "M12 7v6M12 17h.01" : "M12 11v6M12 7h.01"} />
    </svg>
  );
}

/**
 * The mode choice and "Připojit Zotero" in one form: a navigation to the
 * connect route with mode=read|write from real radio inputs, which answers
 * 303 to zotero.org (never fetch — the consent page must open in this tab,
 * and the state cookie comes with that answer). `onCancel` (reconnecting)
 * adds Zrušit; `autoFocus` puts focus on the chosen card when the form
 * replaces the button that opened it.
 */
function ConnectChoice({
  initial = "write",
  label = "Připojit Zotero",
  onCancel,
  autoFocus = false,
}: {
  initial?: ZoteroModeView;
  label?: string;
  onCancel?: () => void;
  autoFocus?: boolean;
}) {
  const [mode, setMode] = useState<ZoteroModeView>(initial);
  const [sent, setSent] = useState(false);
  const labelId = useId();
  const name = useId();
  const chosen = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus) chosen.current?.focus();
    // Mount only: re-focusing on every choice would fight the arrow keys.
  }, []);
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
      <p className="zd-zotero-label" id={labelId}>
        Co smí Dawmain v knihovně dělat
      </p>
      <div className="zd-zotero-modes" role="radiogroup" aria-labelledby={labelId}>
        {MODES.map((m) => (
          <label key={m.value} className="zd-zotero-mode" data-selected={mode === m.value ? "true" : undefined}>
            <input
              ref={mode === m.value ? chosen : undefined}
              type="radio"
              name={`mode-${name}`}
              value={m.value}
              checked={mode === m.value}
              onChange={() => setMode(m.value)}
            />
            <span className="zd-zotero-mode-text">
              <span className="zd-zotero-mode-title">{m.title}</span>
              <span className="zd-zotero-mode-desc">{m.text}</span>
            </span>
          </label>
        ))}
      </div>
      {/* The radios' own names are unique per form (two forms may coexist briefly); the route reads `mode`. */}
      <input type="hidden" name="mode" value={mode} />
      <p className="zd-zotero-hint">Volbu změníte kdykoli tak, že Zotero připojíte znovu.</p>
      <div className="zd-zotero-actions">
        <button type="submit" className="zd-btn zd-btn-primary zd-btn-tall" disabled={sent}>
          {sent ? "Přecházím na Zotero…" : label}
        </button>
        {onCancel ? (
          <button type="button" className="zd-btn zd-btn-tall" onClick={onCancel} disabled={sent}>
            Zrušit
          </button>
        ) : null}
      </div>
    </form>
  );
}

/**
 * "Připojit znovu": the button, or — once clicked — the mode choice in its
 * place (Zrušit brings the button back, focused). `children` are the other
 * actions of the row (Odpojit), hidden while choosing.
 */
function Reconnectable({ initial, children }: { initial: ZoteroModeView; children?: ReactNode }) {
  const [choosing, setChoosing] = useState(false);
  const [refocus, setRefocus] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!refocus || choosing) return;
    setRefocus(false);
    trigger.current?.focus();
  }, [refocus, choosing]);
  if (choosing) {
    return (
      <ConnectChoice
        initial={initial}
        label="Připojit znovu"
        autoFocus
        onCancel={() => {
          setChoosing(false);
          setRefocus(true);
        }}
      />
    );
  }
  return (
    <div className="zd-zotero-actions zd-zotero-divided">
      <button ref={trigger} type="button" className="zd-btn zd-btn-tall" onClick={() => setChoosing(true)}>
        Připojit znovu
      </button>
      {children}
    </div>
  );
}

function NotConnected() {
  const headingId = useId();
  return (
    <>
      <section className="zd-zotero-section" aria-labelledby={headingId}>
        <h3 id={headingId}>Připojte svou knihovnu Zotero</h3>
        <p className="zd-zotero-lead">
          Asistent pak při rešerši hledá a čte i ve vaší knihovně na zotero.org, včetně skupin, kterých jste členem – vedle oficiálních databází.
        </p>
      </section>
      <ConnectChoice />
    </>
  );
}

function Connected({ connection, warning, onChanged }: { connection: ZoteroConnectionView; warning: string | null; onChanged: () => void }) {
  const headingId = useId();
  const from = since(connection.connectedAt);
  const mode = modeText(connection.mode);
  return (
    <>
      <section className="zd-zotero-section" aria-labelledby={headingId}>
        <div className="zd-zotero-who">
          <span className="zd-zotero-mark" aria-hidden="true">
            <ZIcon name="library" size={18} />
          </span>
          <div className="zd-zotero-who-text">
            <h3 id={headingId}>
              Připojeno jako <span className="zd-zotero-user">{connection.username}</span>
            </h3>
            <p className="zd-zotero-sub">{from ? `${from} · ${mode}` : mode}</p>
          </div>
        </div>
      </section>
      {warning ? <p className="zd-banner">{warning}</p> : null}
      <Reconnectable initial={connection.mode}>
        <Disconnect question="Odpojit Zotero? Asistent pak do vaší knihovny neuvidí. Připojit ji můžete kdykoli znovu." onDone={onChanged} />
      </Reconnectable>
    </>
  );
}

/** Revoked or unreadable: why, and "Připojit znovu" (the mode choice). A new key replaces the leftover record. */
function Reconnect({ title, who, text }: { title: string; who: string; text: string }) {
  const headingId = useId();
  return (
    <>
      <section className="zd-zotero-section" aria-labelledby={headingId}>
        <div className="zd-zotero-who">
          <span className="zd-zotero-mark" data-tone="bad" aria-hidden="true">
            <Glyph mark="i" size={18} />
          </span>
          <div className="zd-zotero-who-text">
            <h3 id={headingId}>{title}</h3>
            <p className="zd-zotero-sub">{who}</p>
          </div>
        </div>
        <p className="zd-zotero-lead">{text}</p>
      </section>
      <Reconnectable initial="write" />
    </>
  );
}

/** "Odpojit" behind an inline confirmation; POST disconnect, then the parent reloads the status. */
function Disconnect({ question, onDone }: { question: string; onDone: () => void }) {
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
    <div className="zd-zotero-disconnect" data-confirming={confirming ? "true" : undefined}>
      {confirming ? (
        <Confirm question={question} confirmLabel="Odpojit" busy={busy} onConfirm={() => void disconnect()} onCancel={cancel} />
      ) : (
        <button ref={trigger} type="button" className="zd-btn zd-btn-tall" onClick={() => setConfirming(true)}>
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
