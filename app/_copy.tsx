"use client";

import { useState } from "react";

/**
 * A value with a copy button: the endpoint address, the sample question.
 * Client-side only for the clipboard; the value itself comes from the caller.
 */
export function CopyField({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable (permissions, http) - the value stays
      // selectable by hand, so silently doing nothing is fine.
    }
  }

  return (
    <div className="copy">
      <code>{value}</code>
      <button type="button" onClick={copy} aria-label={label} data-copied={copied}>
        {copied ? "Zkopírováno" : "Kopírovat"}
      </button>
    </div>
  );
}
