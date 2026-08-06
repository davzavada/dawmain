import { useState } from 'react';
import { RELATION_TYPES, isDirected } from '@crm/shared';
import { api, useAppMutation, usePeople } from '../api/queries';
import { Btn, ErrorText, Field, Input, Select } from './ui';

export default function RelationForm({
  personId,
  onDone,
}: {
  personId: number;
  onDone: () => void;
}) {
  const [form, setForm] = useState({
    otherId: '',
    type: RELATION_TYPES[0].value,
    reversed: false,
    date: '',
    note: '',
  });
  const people = usePeople('', '');
  const save = useAppMutation(api.createRelation, onDone);

  const others = (people.data ?? []).filter((p) => p.id !== personId);
  const directed = isDirected(form.type);

  return (
    <form
      className="space-y-2 rounded-md bg-slate-50 p-2"
      onSubmit={(e) => {
        e.preventDefault();
        const otherId = Number(form.otherId);
        if (!otherId) return;
        save.mutate({
          from_person_id: form.reversed ? otherId : personId,
          to_person_id: form.reversed ? personId : otherId,
          type: form.type,
          date: form.date.trim() || null,
          note: form.note.trim() || null,
        });
      }}
    >
      <div className="grid grid-cols-2 gap-2">
        <Field label="Person">
          <Select
            value={form.otherId}
            onChange={(e) => setForm((f) => ({ ...f, otherId: e.target.value }))}
            autoFocus
          >
            <option value="">— select —</option>
            {others.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Relation type">
          <Select
            value={form.type}
            onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}
          >
            {RELATION_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {directed && (
        <label className="flex items-center gap-2 text-xs text-slate-600">
          <input
            type="checkbox"
            checked={form.reversed}
            onChange={(e) => setForm((f) => ({ ...f, reversed: e.target.checked }))}
          />
          Reverse direction (they → this person)
        </label>
      )}
      <div className="grid grid-cols-2 gap-2">
        <Field label="Date / since">
          <Input
            value={form.date}
            onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
            placeholder="2024 or 2024-06-12"
          />
        </Field>
        <Field label="Note">
          <Input
            value={form.note}
            onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
            placeholder="ICON-S panel"
          />
        </Field>
      </div>
      <div className="flex justify-end gap-2">
        <Btn variant="subtle" onClick={onDone}>
          Cancel
        </Btn>
        <Btn type="submit" disabled={!form.otherId || save.isPending}>
          Add relation
        </Btn>
      </div>
      <ErrorText error={save.error} />
    </form>
  );
}
