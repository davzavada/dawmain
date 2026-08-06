import { useState } from 'react';
import { api, useAppMutation, useInstitutions } from '../api/queries';
import { Btn, ErrorText, Field, Input } from './ui';

export default function AffiliationForm({
  personId,
  onDone,
}: {
  personId: number;
  onDone: () => void;
}) {
  const [form, setForm] = useState({ institution: '', role: '', start: '', end: '' });
  const institutions = useInstitutions('');
  const save = useAppMutation(api.addAffiliation, onDone);

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  return (
    <form
      className="space-y-2 rounded-md bg-slate-50 p-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!form.institution.trim()) return;
        save.mutate({
          personId,
          input: {
            institution_name: form.institution.trim(),
            role: form.role.trim() || null,
            start_date: form.start.trim() || null,
            end_date: form.end.trim() || null,
          },
        });
      }}
    >
      <Field label="Institution (new names are created automatically)">
        <Input
          list="institution-names"
          value={form.institution}
          onChange={set('institution')}
          placeholder="Univerzita Karlova, Právnická fakulta"
          autoFocus
        />
        <datalist id="institution-names">
          {(institutions.data ?? []).map((i) => (
            <option key={i.id} value={i.name} />
          ))}
        </datalist>
      </Field>
      <div className="grid grid-cols-3 gap-2">
        <Field label="Role">
          <Input value={form.role} onChange={set('role')} placeholder="doktorand" />
        </Field>
        <Field label="From">
          <Input value={form.start} onChange={set('start')} placeholder="2023" />
        </Field>
        <Field label="To (empty = current)">
          <Input value={form.end} onChange={set('end')} placeholder="" />
        </Field>
      </div>
      <div className="flex justify-end gap-2">
        <Btn variant="subtle" onClick={onDone}>
          Cancel
        </Btn>
        <Btn type="submit" disabled={!form.institution.trim() || save.isPending}>
          Add affiliation
        </Btn>
      </div>
      <ErrorText error={save.error} />
    </form>
  );
}
