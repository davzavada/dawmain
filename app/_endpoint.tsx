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
    <div className="endpoint">
      <code>{endpoint}</code>
      <button type="button" onClick={copy} aria-label="Zkopírovat adresu" data-copied={copied}>
        {copied ? "Zkopírováno" : "Kopírovat"}
      </button>
    </div>
  );
}
