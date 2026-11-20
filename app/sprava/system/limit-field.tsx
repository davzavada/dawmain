"use client";

import { useEffect, useState, useTransition } from "react";
import { MAX_DAILY_CALL_LIMIT, MIN_DAILY_CALL_LIMIT, validDailyLimit } from "@/src/mcp/daily-limit-config";
import { formatCount } from "../../_zdroje/format";
import { setDailyLimitAction } from "../actions";

/**
 * What the admin typed as a limit: a whole number (spaces between thousands
 * are fine), null for an empty field or 0 (= back to the default), NaN for
 * anything else. Pure (exported for tests).
 */
export function limitTextToValue(text: string): number | null {
  const t = text.replace(/\s/g, "");
  if (t === "" || /^0+$/.test(t)) return null;
  if (!/^\d{1,7}$/.test(t)) return NaN;
  const n = Number(t);
  return validDailyLimit(n) ? n : NaN;
}

/**
 * The daily call limit row of Správa → Systém, shaped as the storage quota
 * row (../quota-field.tsx): a number, Uložit, and Výchozí while an own
 * value applies. An empty field or 0 saved means the default.
 */
export function DailyLimitField({ own, defaultLimit, available }: { own: number | null; defaultLimit: number; available: boolean }) {
  const [saved, setSaved] = useState(own);
  const [text, setText] = useState(String(own ?? defaultLimit));
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  useEffect(() => {
    setSaved(own);
    setText(String(own ?? defaultLimit));
  }, [own, defaultLimit]);

  const current = saved ?? defaultLimit;
  const value = limitTextToValue(text);
  const valid = value === null || !Number.isNaN(value);
  // null (empty / 0) is a change only while an own value applies.
  const changed = valid && (value === null ? saved !== null : value !== current);
  const disabled = pending || !available;

  function save(next: number | null) {
    setMessage(null);
    startTransition(async () => {
      const result = await setDailyLimitAction(next);
      if (result.ok) {
        setSaved(result.own);
        setText(String(result.own ?? defaultLimit));
      } else {
        setMessage(result.error);
      }
    });
  }

  return (
    <>
      <form
        className="adm-row adm-quota"
        onSubmit={(e) => {
          e.preventDefault();
          if (changed) save(value);
        }}
      >
        <div>
          <b>Denní limit volání na účet</b>
          <span>
            {!available
              ? `Výchozí: ${formatCount(defaultLimit)} volání za den (databáze není dostupná, změnit nejde)`
              : saved === null
                ? `Výchozí: ${formatCount(defaultLimit)} volání za den`
                : `Vlastní (výchozí je ${formatCount(defaultLimit)})`}
          </span>
        </div>
        <div className="adm-quota-form">
          <label
            className="adm-quota-gb"
            title={valid ? undefined : `Zadej celé číslo ${MIN_DAILY_CALL_LIMIT} až ${formatCount(MAX_DAILY_CALL_LIMIT)} (prázdné nebo 0 = výchozí)`}
          >
            <input
              className="adm-quota-input"
              inputMode="numeric"
              value={text}
              onChange={(e) => setText(e.target.value)}
              aria-label="Denní limit volání nástrojů na účet"
              aria-invalid={!valid}
              disabled={disabled}
            />
            <span aria-hidden="true">volání</span>
          </label>
          <button type="submit" className="zd-btn" disabled={disabled || !changed}>
            Uložit
          </button>
          <button
            type="button"
            className="zd-btn"
            disabled={disabled || saved === null}
            style={saved === null ? { visibility: "hidden" } : undefined}
            aria-hidden={saved === null || undefined}
            tabIndex={saved === null ? -1 : undefined}
            onClick={() => save(null)}
          >
            Výchozí
          </button>
        </div>
      </form>
      {message ? (
        <p className="zd-error" role="alert">
          {message}
        </p>
      ) : null}
    </>
  );
}
