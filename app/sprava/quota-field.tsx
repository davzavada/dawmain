"use client";

import { useEffect, useState } from "react";
import { formatStorageBytes as formatBytes } from "../_zdroje/format";
import { MAX_QUOTA_MB, validQuotaMb } from "@/src/admin/model";

/** MB as the GB an admin types: "4", "0,5", "1,25". Pure (exported for tests). */
export function mbToGbText(mb: number): string {
  return String(Math.round((mb / 1024) * 100) / 100).replace(".", ",");
}

/** What the admin typed (GB, comma or dot) as whole MB, or NaN. Pure (exported for tests). */
export function gbTextToMb(text: string): number {
  const t = text.trim().replace(",", ".");
  if (!/^\d{1,4}(\.\d{1,3})?$/.test(t)) return NaN;
  return Math.round(Number(t) * 1024);
}

/**
 * The storage quota row of Správa (an account or a team): typed in GB,
 * saved in MB. The row never changes its shape: "Výchozí" keeps its place
 * (hidden while the default applies) and a bad value only marks the field.
 */
export function QuotaField({
  ownMb,
  defaultMb,
  pending,
  label,
  onSave,
}: {
  /** The account's or team's own quota in MB, or null for the default. */
  ownMb: number | null;
  defaultMb: number;
  pending: boolean;
  /** Accessible name of the field, e.g. "Kvóta úložiště týmu". */
  label: string;
  /** A new quota in MB, or null = back to the default. */
  onSave: (mb: number | null) => void;
}) {
  const current = ownMb ?? defaultMb;
  const [text, setText] = useState(mbToGbText(current));
  useEffect(() => setText(mbToGbText(current)), [current]);
  const mb = gbTextToMb(text);
  const valid = validQuotaMb(mb);
  const changed = valid && mb !== current;
  const defaultLabel = formatBytes(defaultMb * 1024 * 1024);
  return (
    <form
      className="adm-row adm-row-sub adm-quota"
      onSubmit={(e) => {
        e.preventDefault();
        if (changed) onSave(mb);
      }}
    >
      <div>
        <b>Kvóta úložiště</b>
        <span>{ownMb === null ? `Výchozí: ${defaultLabel}` : `Vlastní (výchozí je ${defaultLabel})`}</span>
      </div>
      <div className="adm-quota-form">
        <label className="adm-quota-gb" title={valid ? undefined : `Zadej 0,01 až ${Math.floor(MAX_QUOTA_MB / 1024)} GB`}>
          <input
            className="adm-quota-input"
            inputMode="decimal"
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-label={`${label} v GB`}
            aria-invalid={text.trim() !== "" && !valid}
            disabled={pending}
          />
          <span aria-hidden="true">GB</span>
        </label>
        <button type="submit" className="zd-btn" disabled={pending || !changed}>
          Uložit
        </button>
        <button
          type="button"
          className="zd-btn"
          disabled={pending || ownMb === null}
          style={ownMb === null ? { visibility: "hidden" } : undefined}
          aria-hidden={ownMb === null || undefined}
          tabIndex={ownMb === null ? -1 : undefined}
          onClick={() => onSave(null)}
        >
          Výchozí
        </button>
      </div>
    </form>
  );
}
