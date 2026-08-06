import { useEffect, useRef } from 'react';
import cytoscape, { type Core } from 'cytoscape';
import fcose from 'cytoscape-fcose';
import { COAUTHOR_EDGE_COLOR, relationColor, type GraphData } from '@crm/shared';

cytoscape.use(fcose);

export interface GraphFilters {
  /** null = all types enabled */
  enabledTypes: Set<string> | null;
  showCoauthor: boolean;
  hideIsolated: boolean;
}

export interface GraphFocus {
  rootId: number;
  hops: number;
}

interface Props {
  data: GraphData;
  selectedId?: number;
  filters: GraphFilters;
  focus: GraphFocus | null;
  onSelect: (id: number | null) => void;
  onFocus: (id: number) => void;
  relayoutKey: number;
}

const LAYOUT = {
  name: 'fcose',
  animate: true,
  animationDuration: 400,
  idealEdgeLength: 90,
  nodeRepulsion: 8000,
  padding: 40,
} as const;

function edgeVisible(
  edge: GraphData['edges'][number],
  filters: GraphFilters,
): boolean {
  if (edge.kind === 'coauthor') return filters.showCoauthor;
  return filters.enabledTypes === null || filters.enabledTypes.has(edge.type);
}

/** Returns the set of element ids hidden under the current filters + focus. */
function computeHidden(data: GraphData, filters: GraphFilters, focus: GraphFocus | null): Set<string> {
  const hidden = new Set<string>();
  const visibleEdges = data.edges.filter((e) => edgeVisible(e, filters));
  for (const edge of data.edges) {
    if (!edgeVisible(edge, filters)) hidden.add(edge.id);
  }

  let reachable: Set<number> | null = null;
  if (focus) {
    reachable = new Set([focus.rootId]);
    let frontier = new Set([focus.rootId]);
    for (let hop = 0; hop < focus.hops; hop += 1) {
      const next = new Set<number>();
      for (const edge of visibleEdges) {
        if (frontier.has(edge.source) && !reachable.has(edge.target)) next.add(edge.target);
        if (frontier.has(edge.target) && !reachable.has(edge.source)) next.add(edge.source);
      }
      next.forEach((id) => reachable!.add(id));
      frontier = next;
      if (frontier.size === 0) break;
    }
    for (const edge of visibleEdges) {
      if (!reachable.has(edge.source) || !reachable.has(edge.target)) hidden.add(edge.id);
    }
  }

  const nodeHasVisibleEdge = new Set<number>();
  for (const edge of visibleEdges) {
    if (hidden.has(edge.id)) continue;
    nodeHasVisibleEdge.add(edge.source);
    nodeHasVisibleEdge.add(edge.target);
  }
  for (const node of data.nodes) {
    if (reachable && !reachable.has(node.id)) {
      hidden.add(`p${node.id}`);
    } else if (filters.hideIsolated && !nodeHasVisibleEdge.has(node.id)) {
      hidden.add(`p${node.id}`);
    }
  }
  return hidden;
}

export default function GraphCanvas({
  data,
  selectedId,
  filters,
  focus,
  onSelect,
  onFocus,
  relayoutKey,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const callbacksRef = useRef({ onSelect, onFocus });
  callbacksRef.current = { onSelect, onFocus };

  useEffect(() => {
    const cy = cytoscape({
      container: containerRef.current,
      wheelSensitivity: 0.3,
      style: [
        {
          selector: 'node',
          style: {
            label: 'data(name)',
            width: 'data(size)',
            height: 'data(size)',
            'background-color': '#334155',
            'font-size': 10,
            color: '#0f172a',
            'text-valign': 'bottom',
            'text-margin-y': 4,
            'text-outline-color': '#f8fafc',
            'text-outline-width': 2,
          },
        },
        {
          selector: 'node.selected',
          style: {
            'background-color': '#1d4ed8',
            'border-width': 3,
            'border-color': '#93c5fd',
          },
        },
        {
          selector: 'edge',
          style: {
            width: 2,
            'curve-style': 'bezier',
            'line-color': 'data(color)',
            opacity: 0.85,
          },
        },
        {
          selector: 'edge[kind = "relation"][?directed]',
          style: {
            'target-arrow-shape': 'triangle',
            'target-arrow-color': 'data(color)',
            'arrow-scale': 0.9,
          },
        },
        {
          selector: 'edge[kind = "coauthor"]',
          style: {
            'line-style': 'dashed',
            width: 'data(width)',
            opacity: 0.7,
          },
        },
        { selector: '.hidden', style: { display: 'none' } },
      ],
    });
    cy.on('tap', 'node', (event) => {
      callbacksRef.current.onSelect(event.target.data('personId'));
    });
    cy.on('dbltap', 'node', (event) => {
      callbacksRef.current.onFocus(event.target.data('personId'));
    });
    cy.on('tap', (event) => {
      if (event.target === cy) callbacksRef.current.onSelect(null);
    });
    cyRef.current = cy;
    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, []);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.elements().remove();
    cy.add([
      ...data.nodes.map((node) => ({
        group: 'nodes' as const,
        data: {
          id: `p${node.id}`,
          personId: node.id,
          name: node.name,
          size: 18 + Math.min(node.degree * 3, 24),
        },
      })),
      ...data.edges.map((edge) => ({
        group: 'edges' as const,
        data: {
          id: edge.id,
          source: `p${edge.source}`,
          target: `p${edge.target}`,
          kind: edge.kind,
          directed: edge.kind === 'relation' ? edge.directed : false,
          color: edge.kind === 'relation' ? relationColor(edge.type) : COAUTHOR_EDGE_COLOR,
          width: edge.kind === 'coauthor' ? Math.min(1 + edge.weight, 5) : 2,
        },
      })),
    ]);
    cy.layout(LAYOUT).run();
  }, [data]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const hidden = computeHidden(data, filters, focus);
    cy.elements().forEach((el) => {
      if (hidden.has(el.id())) el.addClass('hidden');
      else el.removeClass('hidden');
    });
  }, [data, filters, focus]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.nodes().removeClass('selected');
    if (selectedId !== undefined) {
      cy.getElementById(`p${selectedId}`).addClass('selected');
    }
  }, [selectedId, data]);

  useEffect(() => {
    if (relayoutKey > 0) cyRef.current?.layout(LAYOUT).run();
  }, [relayoutKey]);

  return <div ref={containerRef} className="h-full w-full" />;
}
