import type { LibrarySummary } from "@/src/files/web-types";
import { avatarColor, initials } from "./format";
import { ZIcon } from "./icons";

/**
 * The mark of a library in the sidebar and on its page: a team's logo (set
 * by an admin in Správa → Týmy) or its initials on a stable colour; the
 * personal library gets the person icon.
 */
export function LibraryMark({ lib, size = 18 }: { lib: Pick<LibrarySummary, "id" | "kind" | "name" | "logoUrl">; size?: number }) {
  const radius = Math.round(size / 4);
  if (lib.kind === "user") {
    return (
      <span className="lib-mark lib-mark-user" style={{ width: size, height: size, borderRadius: radius }} aria-hidden="true">
        <ZIcon name="library" size={Math.round(size * 0.6)} />
      </span>
    );
  }
  if (lib.logoUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- a Clerk-hosted logo, already sized by Clerk's CDN
      <img className="lib-mark lib-mark-logo" src={lib.logoUrl} alt="" width={size} height={size} style={{ borderRadius: radius }} />
    );
  }
  return (
    <span
      className="lib-mark"
      style={{ width: size, height: size, borderRadius: radius, background: avatarColor(lib.id), fontSize: Math.max(8, Math.round(size * 0.42)) }}
      aria-hidden="true"
    >
      {initials(lib.name)}
    </span>
  );
}

/** The blue folder of the files page. */
export function FolderGlyph({ size = 28 }: { size?: number }) {
  return (
    <svg className="fp-folder-glyph" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M2 6.2A2.2 2.2 0 0 1 4.2 4h4.5c.55 0 1.08.2 1.48.58L11.8 6h7.99A2.2 2.2 0 0 1 22 8.2v9.6a2.2 2.2 0 0 1-2.2 2.2H4.2A2.2 2.2 0 0 1 2 17.8z"
        fill="var(--folder-back)"
      />
      <path d="M2 9.4A1.4 1.4 0 0 1 3.4 8h17.2A1.4 1.4 0 0 1 22 9.4v8.4a2.2 2.2 0 0 1-2.2 2.2H4.2A2.2 2.2 0 0 1 2 17.8z" fill="var(--folder-front)" />
    </svg>
  );
}
