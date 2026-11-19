/**
 * A loading placeholder instead of a spinner: shimmering bars shaped like
 * what is coming — rows of a list, or lines of text — from the first frame,
 * so the content replaces them without a jump (the real rows fade in, see
 * app/globals.css). Pure CSS, works before hydration too; a screen reader
 * hears `label` at once. Plain element: usable from server and client.
 */
export function Loading({ label, shape = "lines", count = 3, className }: { label: string; shape?: "rows" | "lines"; count?: number; className?: string }) {
  return (
    <div className={className ? `zd-loading ${className}` : "zd-loading"} data-shape={shape} role="status">
      {label ? <span className="sr-only">{label}</span> : null}
      {Array.from({ length: count }, (_, i) => (
        <span key={i} className="zd-shimmer-row" aria-hidden="true">
          {shape === "rows" ? <span className="zd-shimmer zd-shimmer-icon" /> : null}
          <span className="zd-shimmer zd-shimmer-bar" style={{ width: `${[72, 54, 64, 46, 58][i % 5]}%` }} />
        </span>
      ))}
    </div>
  );
}
