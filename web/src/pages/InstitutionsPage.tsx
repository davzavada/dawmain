import { useState } from 'react';
import type { InstitutionInput, InstitutionListItem } from '@crm/shared';
import { api, useAppMutation, useInstitutions } from '../api/queries';
import { Btn, ErrorText, Field, Input, Loading, Modal } from '../components/ui';

function InstitutionForm({
  institution,
  onClose,
}: {
  institution?: InstitutionListItem;
  onClose: () => void;
}) {
  const [form, setForm] = useState({
    name: institution?.name ?? '',
    short_name: institution?.short_name ?? '',
    city: institution?.city ?? '',
    country: institution?.country ?? '',
    url: institution?.url ?? '',
    ror_id: institution?.ror_id ?? '',
  });
  const save = useAppMutation(async () => {
    const input: InstitutionInput = {
      name: form.name.trim(),
      short_name: form.short_name.trim() || null,
      city: form.city.trim() || null,
      country: form.country.trim() || null,
      url: form.url.trim() || null,
      ror_id: form.ror_id.trim() || null,
    };
    return institution
      ? api.patchInstitution({ id: institution.id, patch: input })
      : api.createInstitution(input);
  }, onClose);

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  return (
    <Modal title={institution ? `Edit ${institution.name}` : 'Add institution'} onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (form.name.trim()) save.mutate(undefined);
        }}
      >
        <Field label="Name *">
          <Input value={form.name} onChange={set('name')} autoFocus />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Short name">
            <Input value={form.short_name} onChange={set('short_name')} placeholder="PF UK" />
          </Field>
          <Field label="City">
            <Input value={form.city} onChange={set('city')} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Country">
            <Input value={form.country} onChange={set('country')} placeholder="CZ" />
          </Field>
          <Field label="ROR iD">
            <Input value={form.ror_id} onChange={set('ror_id')} placeholder="https://ror.org/…" />
          </Field>
        </div>
        <Field label="Website">
          <Input value={form.url} onChange={set('url')} placeholder="https://…" />
        </Field>
        <div className="flex justify-end gap-2 pt-1">
          <Btn variant="subtle" onClick={onClose}>
            Cancel
          </Btn>
          <Btn type="submit" disabled={!form.name.trim() || save.isPending}>
            {institution ? 'Save' : 'Create'}
          </Btn>
        </div>
        <ErrorText error={save.error} />
      </form>
    </Modal>
  );
}

export default function InstitutionsPage() {
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<InstitutionListItem | 'new' | null>(null);
  const institutions = useInstitutions(search);
  const remove = useAppMutation(api.deleteInstitution);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-slate-200 bg-white px-4 py-2.5">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search institutions…"
          className="!w-64"
        />
        <div className="flex-1" />
        <Btn onClick={() => setEditing('new')}>Add institution</Btn>
      </div>

      {institutions.isLoading ? (
        <Loading />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-4 py-2 font-medium">City</th>
                <th className="px-4 py-2 font-medium">Country</th>
                <th className="px-2 py-2 text-right font-medium">People</th>
                <th className="px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {(institutions.data ?? []).map((inst) => (
                <tr key={inst.id} className="group border-t border-slate-100 hover:bg-slate-50">
                  <td className="px-4 py-2">
                    <span className="font-medium">{inst.name}</span>
                    {inst.short_name && (
                      <span className="ml-1 text-xs text-slate-400">({inst.short_name})</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-xs text-slate-500">{inst.city ?? ''}</td>
                  <td className="px-4 py-2 text-xs text-slate-500">{inst.country ?? ''}</td>
                  <td className="px-2 py-2 text-right text-xs text-slate-500">
                    {inst.person_count}
                  </td>
                  <td className="px-2 py-2 text-right">
                    <span className="invisible flex justify-end gap-1 group-hover:visible">
                      <Btn variant="ghost" onClick={() => setEditing(inst)}>
                        Edit
                      </Btn>
                      <Btn
                        variant="ghost"
                        onClick={() => {
                          if (
                            confirm(
                              `Delete ${inst.name}? Affiliations of ${inst.person_count} people go with it.`,
                            )
                          ) {
                            remove.mutate(inst.id);
                          }
                        }}
                      >
                        Delete
                      </Btn>
                    </span>
                  </td>
                </tr>
              ))}
              {(institutions.data ?? []).length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-sm text-slate-400">
                    No institutions yet — they are created automatically when you add affiliations.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <InstitutionForm
          institution={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
