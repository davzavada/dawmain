export interface RelationTypeDef {
  value: string;
  label: string;
  directed: boolean;
  color: string;
}

export const RELATION_TYPES: RelationTypeDef[] = [
  { value: 'met_at_conference', label: 'Met at conference', directed: false, color: '#7c3aed' },
  { value: 'colleague', label: 'Colleague', directed: false, color: '#2563eb' },
  { value: 'friend', label: 'Friend', directed: false, color: '#16a34a' },
  { value: 'coauthor', label: 'Co-author (manual)', directed: false, color: '#64748b' },
  { value: 'supervisor', label: 'Supervisor of', directed: true, color: '#d97706' },
  { value: 'reviewer', label: 'Reviewed work of', directed: true, color: '#0d9488' },
];

export const UNKNOWN_RELATION_COLOR = '#9ca3af';
export const COAUTHOR_EDGE_COLOR = '#cbd5e1';

export function relationTypeDef(value: string): RelationTypeDef | undefined {
  return RELATION_TYPES.find((t) => t.value === value);
}

export function isDirected(value: string): boolean {
  return relationTypeDef(value)?.directed ?? false;
}

export function relationColor(value: string): string {
  return relationTypeDef(value)?.color ?? UNKNOWN_RELATION_COLOR;
}

export function relationLabel(value: string): string {
  return relationTypeDef(value)?.label ?? value;
}
