/**
 * A loading placeholder instead of a spinner: nothing at all for the first
 * moment (most loads finish before anyone notices), then shimmering bars
 * shaped like what is coming — rows of a list, or lines of text. The delay
 * is pure CSS (.zd-loading, app/globals.css), so it works before hydration
 * too; a screen reader hears `label` at once. Plain element: usable from
 * server and client.
 */
export function Loading({ label, shape = "lines", count = 3, className }: { label: string; shape?: "rows" | "lines"; count?: number; className?: string }) {
  return (
    <div className={className ? `zd-loading ${className}` : "zd-loading"} data-shape={shape} role="status">
      <span className="sr-only">{label}</span>
      {Array.from({ length: count }, (_, i) => (
        <span key={i} className="zd-shimmer-row" aria-hidden="true">
          {shape === "rows" ? <span className="zd-shimmer zd-shimmer-icon" /> : null}
          <span className="zd-shimmer zd-shimmer-bar" style={{ width: `${[72, 54, 64, 46, 58][i % 5]}%` }} />
        </span>
      ))}
    </div>
  );
}
