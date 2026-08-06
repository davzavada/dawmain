import { COAUTHOR_EDGE_COLOR, RELATION_TYPES, UNKNOWN_RELATION_COLOR } from '@crm/shared';
import type { GraphFilters, GraphFocus } from './GraphCanvas';
import { Btn } from './ui';

interface Props {
  presentTypes: string[];
  filters: GraphFilters;
  onFilters: (next: GraphFilters) => void;
  focus: GraphFocus | null;
  focusName?: string;
  onExpandFocus: () => void;
  onClearFocus: () => void;
  onRelayout: () => void;
}

export default function GraphControls({
  presentTypes,
  filters,
  onFilters,
  focus,
  focusName,
  onExpandFocus,
  onClearFocus,
  onRelayout,
}: Props) {
  const typeEnabled = (type: string) =>
    filters.enabledTypes === null || filters.enabledTypes.has(type);

  const toggleType = (type: string) => {
    const current = filters.enabledTypes ?? new Set(presentTypes);
    const next = new Set(current);
    if (next.has(type)) next.delete(type);
    else next.add(type);
    onFilters({ ...filters, enabledTypes: next });
  };

  return (
    <div className="absolute left-3 top-3 z-10 w-56 rounded-lg border border-slate-200 bg-white/95 p-3 text-xs shadow-md backdrop-blur">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-semibold uppercase tracking-wide text-slate-500">Edges</span>
        <Btn variant="ghost" onClick={onRelayout} title="Re-run layout">
          Re-layout
        </Btn>
      </div>
      <div className="space-y-1">
        {presentTypes.map((type) => {
          const def = RELATION_TYPES.find((t) => t.value === type);
          return (
            <label key={type} className="flex cursor-pointer items-center gap-2">
              <input type="checkbox" checked={typeEnabled(type)} onChange={() => toggleType(type)} />
              <span
                className="inline-block h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: def?.color ?? UNKNOWN_RELATION_COLOR }}
              />
              <span>{def?.label ?? type}</span>
            </label>
          );
        })}
        <label className="flex cursor-pointer items-center gap-2 border-t border-slate-100 pt-1">
          <input
            type="checkbox"
            checked={filters.showCoauthor}
            onChange={(e) => onFilters({ ...filters, showCoauthor: e.target.checked })}
          />
          <span
            className="inline-block h-0.5 w-3 border-t-2 border-dashed"
            style={{ borderColor: COAUTHOR_EDGE_COLOR }}
          />
          <span>Co-authorship (derived)</span>
        </label>
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={filters.hideIsolated}
            onChange={(e) => onFilters({ ...filters, hideIsolated: e.target.checked })}
          />
          <span>Hide unconnected people</span>
        </label>
      </div>
      {focus && (
        <div className="mt-2 space-y-1.5 border-t border-slate-100 pt-2">
          <p className="text-slate-600">
            Focus: <span className="font-medium">{focusName ?? focus.rootId}</span> ({focus.hops} hop
            {focus.hops > 1 ? 's' : ''})
          </p>
          <div className="flex gap-1">
            <Btn variant="subtle" onClick={onExpandFocus}>
              +1 hop
            </Btn>
            <Btn variant="subtle" onClick={onClearFocus}>
              Show all
            </Btn>
          </div>
        </div>
      )}
      {!focus && (
        <p className="mt-2 border-t border-slate-100 pt-2 text-[11px] leading-snug text-slate-400">
          Click a person for details. Double-click to focus on their neighborhood.
        </p>
      )}
    </div>
  );
}
