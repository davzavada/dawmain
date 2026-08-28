/**
 * A pixel-art tabby, asleep in the bottom-right corner of every page.
 * Pure decoration: server-rendered SVG, CSS-only animation, invisible to
 * screen readers and to the pointer. Hidden on narrow screens, where the
 * corner is content's, not the cat's.
 */

/** One character per pixel; `.` is transparent. */
const ROWS = [
  "...o.....o..............",
  "..opo...opo.............",
  "..obbooobbo.............",
  "..obbsbsbbo.............",
  "..obbbbbbbboooooooo.....",
  "..obeebeebbbbsbsbsboo...",
  "..obbbpbbbbbbsbsbsbbbo..",
  "..obbbbbbbbbbsbsbsbbbo..",
  "..obbbbbbbbbbsbsbsbbbo..",
  "..obbbbbbbbbbbbbbbbbbo..",
  "..obbbbbsssbsssbssssso..",
  "..oooooooooooooooooooo..",
];

const PALETTE: Record<string, string> = {
  o: "#4a3524", // outline
  b: "#b5987a", // tabby base
  s: "#83674b", // stripes
  p: "#e8a3a3", // inner ears + nose
  e: "#33241a", // closed eyes
};

const PX = 4;
const WIDTH = ROWS[0].length * PX;
/** Headroom above the sprite where the z's float up. */
const TOP = 28;
const HEIGHT = ROWS.length * PX + TOP;

export function SleepingCat() {
  return (
    <div className="dawmain-cat" aria-hidden="true">
      <style>{`
        .dawmain-cat {
          position: fixed;
          right: 0.75rem;
          bottom: 0;
          pointer-events: none;
          user-select: none;
          line-height: 0;
        }
        .dawmain-cat .z {
          font: bold 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          fill: #9ca3af;
          opacity: 0;
          animation: dawmain-z 4.5s infinite steps(8);
        }
        .dawmain-cat .z2 { animation-delay: 1.5s; }
        .dawmain-cat .z3 { animation-delay: 3s; }
        .dawmain-cat .body { animation: dawmain-breathe 4s steps(1) infinite; }
        @keyframes dawmain-z {
          0% { opacity: 0; transform: translate(0, 0); }
          15% { opacity: 1; }
          100% { opacity: 0; transform: translate(10px, -22px); }
        }
        @keyframes dawmain-breathe {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(1px); }
        }
        @media (prefers-reduced-motion: reduce) {
          .dawmain-cat .z, .dawmain-cat .body { animation: none; }
          .dawmain-cat .z1 { opacity: 0.6; }
        }
        @media (max-width: 480px) {
          .dawmain-cat { display: none; }
        }
      `}</style>
      <svg
        width={WIDTH}
        height={HEIGHT}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        shapeRendering="crispEdges"
      >
        <g className="body" transform={`translate(0 ${TOP})`}>
          {ROWS.flatMap((row, y) =>
            [...row].map((ch, x) =>
              ch === "." ? null : (
                <rect
                  key={`${x}-${y}`}
                  x={x * PX}
                  y={y * PX}
                  width={PX}
                  height={PX}
                  fill={PALETTE[ch]}
                />
              ),
            ),
          )}
        </g>
        <text className="z z1" x={34} y={TOP - 6}>z</text>
        <text className="z z2" x={34} y={TOP - 6}>z</text>
        <text className="z z3" x={34} y={TOP - 6}>z</text>
      </svg>
    </div>
  );
}
