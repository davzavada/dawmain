export interface InteractionKindDef {
  value: string;
  label: string;
  color: string;
}

export const INTERACTION_KINDS: InteractionKindDef[] = [
  { value: 'meeting', label: 'Meeting', color: '#2563eb' },
  { value: 'conference', label: 'Conference', color: '#7c3aed' },
  { value: 'email', label: 'Email', color: '#0d9488' },
  { value: 'call', label: 'Call', color: '#d97706' },
  { value: 'other', label: 'Other', color: '#64748b' },
];

export function interactionKindDef(value: string): InteractionKindDef | undefined {
  return INTERACTION_KINDS.find((k) => k.value === value);
}

export function interactionLabel(value: string): string {
  return interactionKindDef(value)?.label ?? value;
}

export function interactionColor(value: string): string {
  return interactionKindDef(value)?.color ?? '#64748b';
}
