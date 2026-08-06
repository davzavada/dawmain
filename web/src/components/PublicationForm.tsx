import { useState } from 'react';
import { PUBLICATION_TYPES, type PublicationInput, type PublicationListItem } from '@crm/shared';
import { api, useAppMutation, usePeople } from '../api/queries';
import { Btn, ErrorText, Field, Input, Modal, Select } from './ui';

interface AuthorRow {
  name: string;
  person_id: number | null;
}

interface Props {
  publication?: PublicationListItem;
  onClose: () => void;
}

export default function PublicationForm({ publication, onClose }: Props) {
  const [form, setForm] = useState({
    title: publication?.title ?? '',
    year: publication?.year?.toString() ?? '',
    venue: publication?.venue ?? '',
    type: publication?.type ?? 'article',
    doi: publication?.doi ?? '',
    url: publication?.url ?? '',
  });
  const [authors, setAuthors] = useState<AuthorRow[]>(
    publication?.authors.map((a) => ({ name: a.name, person_id: a.person_id })) ?? [
      { name: '', person_id: null },
    ],
  );
  const people = usePeople('', '');

  const save = useAppMutation(async () => {
    const input: PublicationInput = {
      title: form.title.trim(),
      year: form.year.trim() ? Number(form.year) : null,
      venue: form.venue.trim() || null,
      type: form.type as PublicationInput['type'],
      doi: form.doi.trim() || null,
      url: form.url.trim() || null,
      authors: authors
        .filter((a) => a.name.trim())
        .map((a) => ({ name: a.name.trim(), person_id: a.person_id })),
    };
    return publication
      ? api.patchPublication({ id: publication.id, patch: input })
      : api.createPublication(input);
  }, onClose);

  const setField = (key: keyof typeof form) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>,
  ) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const updateAuthor = (index: number, patch: Partial<AuthorRow>) =>
    setAuthors((rows) => rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));

  const canSave = form.title.trim() && authors.some((a) => a.name.trim());

  return (
    <Modal title={publication ? 'Edit publication' : 'Add publication'} onClose={onClose} wide>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSave) save.mutate(undefined);
        }}
      >
        <Field label="Title *">
          <Input value={form.title} onChange={setField('title')} autoFocus />
        </Field>
        <div className="grid grid-cols-4 gap-3">
          <Field label="Year">
            <Input value={form.year} onChange={setField('year')} placeholder="2025" />
          </Field>
          <div className="col-span-2">
            <Field label="Venue (journal / publisher)">
              <Input value={form.venue} onChange={setField('venue')} placeholder="Právník" />
            </Field>
          </div>
          <Field label="Type">
            <Select value={form.type} onChange={setField('type')}>
              {PUBLICATION_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t.replace('_', ' ')}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="DOI">
            <Input value={form.doi} onChange={setField('doi')} placeholder="10.1000/xyz" />
          </Field>
          <Field label="URL">
            <Input value={form.url} onChange={setField('url')} placeholder="https://…" />
          </Field>
        </div>

        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs font-medium text-slate-600">
              Authors (in order; link to a contact or leave unlinked — unlinked names become
              suggestions)
            </span>
            <Btn variant="ghost" onClick={() => setAuthors((r) => [...r, { name: '', person_id: null }])}>
              + author
            </Btn>
          </div>
          <div className="space-y-1.5">
            {authors.map((author, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="w-4 text-right text-xs text-slate-400">{i + 1}.</span>
                <Input
                  value={author.name}
                  onChange={(e) => updateAuthor(i, { name: e.target.value })}
                  placeholder="Author name as printed"
                  className="!flex-1"
                />
                <Select
                  value={author.person_id ?? ''}
                  onChange={(e) => {
                    const pid = e.target.value ? Number(e.target.value) : null;
                    const linked = (people.data ?? []).find((p) => p.id === pid);
                    updateAuthor(i, {
                      person_id: pid,
                      name: author.name.trim() || (linked?.name ?? ''),
                    });
                  }}
                  className="!w-48"
                >
                  <option value="">not linked</option>
                  {(people.data ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
                <Btn
                  variant="ghost"
                  onClick={() => setAuthors((rows) => rows.filter((_, j) => j !== i))}
                  disabled={authors.length === 1}
                  title="Remove author row"
                >
                  ✕
                </Btn>
              </div>
            ))}
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-200 pt-3">
          <Btn variant="subtle" onClick={onClose}>
            Cancel
          </Btn>
          <Btn type="submit" disabled={!canSave || save.isPending}>
            {publication ? 'Save' : 'Create'}
          </Btn>
        </div>
        <ErrorText error={save.error} />
      </form>
    </Modal>
  );
}
