import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useGraph } from '../api/queries';
import GraphCanvas, { type GraphFilters, type GraphFocus } from '../components/GraphCanvas';
import GraphControls from '../components/GraphControls';
import PersonDetail from '../components/PersonDetail';
import { Loading } from '../components/ui';

export default function NetworkPage() {
  const { id } = useParams();
  const selectedId = id ? Number(id) : undefined;
  const navigate = useNavigate();
  const graph = useGraph();
  const [filters, setFilters] = useState<GraphFilters>({
    enabledTypes: null,
    showCoauthor: true,
    hideIsolated: false,
  });
  const [focus, setFocus] = useState<GraphFocus | null>(null);
  const [relayoutKey, setRelayoutKey] = useState(0);

  const presentTypes = useMemo(() => {
    const types = new Set<string>();
    for (const edge of graph.data?.edges ?? []) {
      if (edge.kind === 'relation') types.add(edge.type);
    }
    return [...types].sort();
  }, [graph.data]);

  const focusName =
    focus === null
      ? undefined
      : graph.data?.nodes.find((n) => n.id === focus.rootId)?.name;

  return (
    <div className="flex h-full">
      <div className="relative min-w-0 flex-1 bg-slate-100">
        {graph.isLoading && <Loading label="Loading network…" />}
        {graph.data && (
          <>
            <GraphControls
              presentTypes={presentTypes}
              filters={filters}
              onFilters={setFilters}
              focus={focus}
              focusName={focusName}
              onExpandFocus={() => setFocus((f) => (f ? { ...f, hops: f.hops + 1 } : f))}
              onClearFocus={() => setFocus(null)}
              onRelayout={() => setRelayoutKey((k) => k + 1)}
            />
            <GraphCanvas
              data={graph.data}
              selectedId={selectedId}
              filters={filters}
              focus={focus}
              onSelect={(personId) =>
                navigate(personId === null ? '/network' : `/network/${personId}`)
              }
              onFocus={(personId) => setFocus({ rootId: personId, hops: 1 })}
              relayoutKey={relayoutKey}
            />
            {graph.data.nodes.length === 0 && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-slate-400">
                Add people and relations to see your network here.
              </div>
            )}
          </>
        )}
      </div>

      {selectedId !== undefined && (
        <aside className="flex w-[26rem] shrink-0 flex-col border-l border-slate-200 bg-white">
          <div className="flex justify-end border-b border-slate-100 px-2 py-1">
            <button
              type="button"
              onClick={() => navigate('/network')}
              className="text-xs text-slate-400 hover:text-slate-700"
            >
              close ✕
            </button>
          </div>
          <div className="min-h-0 flex-1">
            <PersonDetail personId={selectedId} basePath="/network" />
          </div>
        </aside>
      )}
    </div>
  );
}
