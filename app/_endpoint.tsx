"use client";

import { useState } from "react";

/**
 * The endpoint address with a copy button. The one interactive element on the
 * page, so it is the one client component; the address itself still comes
 * from the server (computed from the request's host in page.tsx).
 */
export function Endpoint({ endpoint }: { endpoint: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(endpoint);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable (permissions, http) - the address stays
      // selectable by hand, so silently doing nothing is fine.
    }
  }

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.75rem",
        background: "#f3f4f6",
        border: "1px solid #e5e7eb",
        borderRadius: "0.5rem",
        padding: "0.75rem 1rem",
      }}
    >
      <code
        style={{
          flex: 1,
          minWidth: 0,
          wordBreak: "break-all",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          fontSize: "0.875rem",
        }}
      >
        {endpoint}
      </code>
      <button
        type="button"
        onClick={copy}
        aria-label="Zkopírovat adresu"
        style={{
          flexShrink: 0,
          border: "1px solid #d1d5db",
          borderRadius: "0.375rem",
          background: copied ? "#dcfce7" : "#ffffff",
          color: copied ? "#166534" : "#374151",
          font: "inherit",
          fontSize: "0.8rem",
          padding: "0.3rem 0.6rem",
          cursor: "pointer",
        }}
      >
        {copied ? "Zkopírováno" : "Kopírovat"}
      </button>
    </div>
  );
}
