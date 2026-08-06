import { useState } from 'react';
import {
  INTERACTION_KINDS,
  interactionColor,
  interactionLabel,
  type Interaction,
} from '@crm/shared';
import { api, useAppMutation } from '../api/queries';
import { Btn, EmptyState, ErrorText, Field, Input, Select } from './ui';

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function InteractionForm({
  initial,
  onSubmit,
  onCancel,
  pending,
  error,
  submitLabel,
}: {
  initial: { date: string; kind: string; note: string };
  onSubmit: (values: { date: string; kind: string; note: string }) => void;
  onCancel: () => void;
  pending: boolean;
  error: unknown;
  submitLabel: string;
}) {
  const [form, setForm] = useState(initial);
  return (
    <form
      className="space-y-2 rounded-md bg-slate-50 p-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (form.date.trim()) onSubmit(form);
      }}
    >
      <div className="grid grid-cols-2 gap-2">
        <Field label="Date">
          <Input
            value={form.date}
            onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
            placeholder="2026-08-06"
            autoFocus
          />
        </Field>
        <Field label="Kind">
          <Select
            value={form.kind}
            onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value }))}
          >
            {INTERACTION_KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label="Note">
        <Input
          value={form.note}
          onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
          placeholder="talked about the AI act draft…"
        />
      </Field>
      <div className="flex justify-end gap-2">
        <Btn variant="subtle" onClick={onCancel}>
          Cancel
        </Btn>
        <Btn type="submit" disabled={!form.date.trim() || pending}>
          {submitLabel}
        </Btn>
      </div>
      <ErrorText error={error} />
    </form>
  );
}

export default function InteractionsSection({
  personId,
  interactions,
}: {
  personId: number;
  interactions: Interaction[];
}) {
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);

  const add = useAppMutation(api.addInteraction, () => setAdding(false));
  const patch = useAppMutation(api.patchInteraction, () => setEditingId(null));
  const remove = useAppMutation(api.deleteInteraction);

  return (
    <>
      {adding && (
        <div className="mb-2">
          <InteractionForm
            initial={{ date: today(), kind: 'meeting', note: '' }}
            onSubmit={(values) =>
              add.mutate({
                personId,
                input: {
                  date: values.date.trim(),
                  kind: values.kind,
                  note: values.note.trim() || null,
                },
              })
            }
            onCancel={() => setAdding(false)}
            pending={add.isPending}
            error={add.error}
            submitLabel="Add interaction"
          />
        </div>
      )}
      {interactions.length === 0 && !adding && (
        <EmptyState>No interactions logged yet — record when you meet, mail or call.</EmptyState>
      )}
      <ul className="space-y-1.5">
        {interactions.map((interaction) =>
          editingId === interaction.id ? (
            <li key={interaction.id}>
              <InteractionForm
                initial={{
                  date: interaction.date,
                  kind: interaction.kind,
                  note: interaction.note ?? '',
                }}
                onSubmit={(values) =>
                  patch.mutate({
                    id: interaction.id,
                    patch: {
                      date: values.date.trim(),
                      kind: values.kind,
                      note: values.note.trim() || null,
                    },
                  })
                }
                onCancel={() => setEditingId(null)}
                pending={patch.isPending}
                error={patch.error}
                submitLabel="Save"
              />
            </li>
          ) : (
            <li key={interaction.id} className="group flex items-baseline gap-2 text-sm">
              <span className="shrink-0 font-mono text-xs text-slate-400">{interaction.date}</span>
              <span
                className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium text-white"
                style={{ backgroundColor: interactionColor(interaction.kind) }}
              >
                {interactionLabel(interaction.kind)}
              </span>
              <span className="min-w-0 flex-1 text-slate-700">{interaction.note}</span>
              <span className="invisible flex shrink-0 gap-1.5 group-hover:visible">
                <button
                  type="button"
                  onClick={() => setEditingId(interaction.id)}
                  className="text-xs text-slate-400 hover:text-slate-700"
                >
                  edit
                </button>
                <button
                  type="button"
                  onClick={() => remove.mutate(interaction.id)}
                  className="text-xs text-slate-400 hover:text-red-600"
                >
                  remove
                </button>
              </span>
            </li>
          ),
        )}
      </ul>
      <ErrorText error={remove.error} />
      {!adding && (
        <div className="mt-2">
          <Btn variant="subtle" onClick={() => setAdding(true)}>
            + Log interaction
          </Btn>
        </div>
      )}
    </>
  );
}
