import { Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import type { InstitutionInput, InstitutionListItem } from '@crm/shared';
import {
  api,
  useAppMutation,
  useInstitutionDetail,
  useInstitutions,
} from '../api/queries';
import { useDebouncedValue } from '../hooks';
import { Btn, ErrorText, Field, Input, LoadState, Modal } from '../components/ui';

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

function InstitutionPeople({ institutionId }: { institutionId: number }) {
  const detail = useInstitutionDetail(institutionId);
  if (detail.isLoading) return <p className="text-xs text-slate-400">Loading people…</p>;
  if (detail.isError) return <ErrorText error={detail.error} />;
  const people = detail.data?.people ?? [];
  if (people.length === 0) {
    return <p className="text-xs text-slate-400">Nobody affiliated yet.</p>;
  }
  return (
    <ul className="space-y-1">
      {people.map((p, i) => (
        <li key={`${p.id}-${i}`} className="text-sm">
          <Link className="font-medium text-blue-700 hover:underline" to={`/people/${p.id}`}>
            {p.name}
          </Link>
          {p.role && <span className="text-xs text-slate-500"> — {p.role}</span>}
          <span className="ml-1 text-xs text-slate-400">
            {p.start_date ?? ''}
            {(p.start_date || p.end_date) && '–'}
            {p.end_date ?? (p.start_date ? 'now' : '')}
            {!p.current && ' · former'}
          </span>
        </li>
      ))}
    </ul>
  );
}

export default function InstitutionsPage() {
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<InstitutionListItem | 'new' | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const debouncedSearch = useDebouncedValue(search);
  const institutions = useInstitutions(debouncedSearch);
  const remove = useAppMutation(api.deleteInstitution);

  const rows = institutions.data ?? [];

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

      <LoadState
        isLoading={institutions.isLoading}
        isError={institutions.isError}
        error={institutions.error}
        onRetry={() => void institutions.refetch()}
      />
      {!institutions.isLoading && !institutions.isError && (
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
              {rows.map((inst) => (
                <Fragment key={inst.id}>
                  <tr
                    onClick={() => setExpandedId((current) => (current === inst.id ? null : inst.id))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter')
                        setExpandedId((current) => (current === inst.id ? null : inst.id));
                    }}
                    tabIndex={0}
                    className={`group cursor-pointer border-t border-slate-100 hover:bg-slate-50 focus:bg-slate-100 focus:outline-none ${
                      expandedId === inst.id ? 'bg-slate-50' : ''
                    }`}
                  >
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
                                `Delete ${inst.name}? Affiliation history of ${inst.person_count} people goes with it.`,
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
                  {expandedId === inst.id && (
                    <tr className="border-t border-slate-100 bg-slate-50/60">
                      <td colSpan={5} className="px-8 py-3">
                        <InstitutionPeople institutionId={inst.id} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-sm text-slate-400">
                    {debouncedSearch.trim()
                      ? 'No institutions match this search.'
                      : 'No institutions yet — they are created automatically when you add affiliations.'}
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
