"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { ZIcon } from "./icons";

/**
 * The modal shell of the design (2b, 3d): a dimmed backdrop, a white card
 * with a header (title, subtitle, close ×), a scrolling body and a footer;
 * a full-screen sheet on phones (2e, 3f). Accessible: role="dialog",
 * aria-modal, labelled by its title, Escape and the backdrop close it,
 * focus moves in on open, Tab cycles inside, and focus returns to what
 * opened it. The page behind does not scroll while it is open.
 */
export function Dialog({
  title,
  subtitle,
  onClose,
  size = "wide",
  footer,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  onClose: () => void;
  size?: "wide" | "narrow";
  footer?: ReactNode;
  children: ReactNode;
}) {
  const card = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // Children's effects run first: keep focus when one of them already placed it inside.
    if (!card.current?.contains(document.activeElement)) card.current?.focus();

    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        // An open inner confirm or menu handles its own Escape first.
        if (event.defaultPrevented) return;
        event.preventDefault();
        close.current();
        return;
      }
      if (event.key !== "Tab" || !card.current) return;
      const focusable = card.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === card.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      opener?.focus?.();
    };
  }, []);

  return (
    <div className="zd-layer">
      <div className="zd-backdrop" onClick={() => close.current()} aria-hidden="true" />
      <div ref={card} className="zd-dialog" data-size={size} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <header className="zd-dialog-head">
          <div className="zd-dialog-titles">
            <h2 id={titleId}>{title}</h2>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          <button type="button" className="zd-icon-button zd-close" onClick={() => close.current()} aria-label="Zavřít" title="Zavřít">
            <ZIcon name="close" />
          </button>
        </header>
        {children}
        {footer ? <footer className="zd-dialog-foot">{footer}</footer> : null}
      </div>
    </div>
  );
}

/**
 * A small inline confirmation (delete, remove a member) inside the dialog:
 * a question with a destructive and a cancel button. Escape cancels.
 */
export function Confirm({
  question,
  confirmLabel,
  busy,
  onConfirm,
  onCancel,
}: {
  question: ReactNode;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancel.current?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        // Capture phase on document: the dialog's own Escape (closing it) never sees this one.
        event.stopPropagation();
        onCancel();
      }
    }
    // Capture phase: runs before the dialog's own Escape handler.
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onCancel]);
  return (
    <div className="zd-confirm" role="alertdialog" aria-live="assertive">
      <span>{question}</span>
      <span className="zd-confirm-actions">
        <button type="button" className="zd-btn zd-btn-danger" onClick={onConfirm} disabled={busy}>
          {busy ? "Pracuji…" : confirmLabel}
        </button>
        <button ref={cancel} type="button" className="zd-btn zd-btn-quiet" onClick={onCancel} disabled={busy}>
          Zrušit
        </button>
      </span>
    </div>
  );
}
