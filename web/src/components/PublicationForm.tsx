import { useEffect, useRef, useState } from 'react';
import {
  PUBLICATION_TYPES,
  READ_STATUSES,
  type PublicationInput,
  type PublicationListItem,
} from '@crm/shared';
import { api, useAppMutation, usePeople, usePublicationDetail } from '../api/queries';
import { Btn, ErrorText, Field, Input, Modal, Select, TextArea } from './ui';

interface AuthorRow {
  key: number;
  name: string;
  person_id: number | null;
  /** name that was auto-filled from the linked contact, if any */
  autoFilledFrom: string | null;
}

interface Props {
  publication?: PublicationListItem;
  /** pre-seeded author rows for "add publication from a person" */
  presetAuthors?: { name: string; person_id: number | null }[];
  onClose: () => void;
}

const STATUS_LABELS: Record<string, string> = {
  none: '—',
  to_read: 'To read',
  read: 'Read',
};

export default function PublicationForm({ publication, presetAuthors, onClose }: Props) {
  const rowKey = useRef(0);
  const nextKey = () => ++rowKey.current;

  const [form, setForm] = useState({
    title: publication?.title ?? '',
    year: publication?.year?.toString() ?? '',
    venue: publication?.venue ?? '',
    type: publication?.type ?? 'article',
    doi: publication?.doi ?? '',
    url: publication?.url ?? '',
    note: publication?.note ?? '',
    abstract: '',
    language: '',
    starred: publication?.starred ?? false,
    read_status: publication?.read_status ?? 'none',
  });
  const [authors, setAuthors] = useState<AuthorRow[]>(() => {
    const seed = publication?.authors.map((a) => ({ name: a.name, person_id: a.person_id }))
      ?? presetAuthors
      ?? [{ name: '', person_id: null }];
    return seed.map((a) => ({ ...a, key: nextKey(), autoFilledFrom: null }));
  });
  const [yearError, setYearError] = useState(false);
  const people = usePeople('', '');

  // abstract + language aren't in the list payload — hydrate them for edits
  const detail = usePublicationDetail(publication?.id);
  const hydrated = useRef(false);
  useEffect(() => {
    if (detail.data && !hydrated.current) {
      hydrated.current = true;
      setForm((f) => ({
        ...f,
        abstract: detail.data.abstract ?? '',
        language: detail.data.language ?? '',
      }));
    }
  }, [detail.data]);

  const save = useAppMutation(async () => {
    const input: PublicationInput = {
      title: form.title.trim(),
      year: form.year.trim() ? Number(form.year) : null,
      venue: form.venue.trim() || null,
      type: form.type as PublicationInput['type'],
      doi: form.doi.trim() || null,
      url: form.url.trim() || null,
      note: form.note.trim() || null,
      abstract: form.abstract.trim() || null,
      language: form.language.trim() || null,
      starred: form.starred,
      read_status: form.read_status as PublicationInput['read_status'],
      authors: authors
        .filter((a) => a.name.trim())
        .map((a) => ({ name: a.name.trim(), person_id: a.person_id })),
    };
    return publication
      ? api.patchPublication({ id: publication.id, patch: input })
      : api.createPublication(input);
  }, onClose);

  const setField =
    (key: keyof typeof form) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm((f) => ({ ...f, [key]: e.target.value }));

  const updateAuthor = (key: number, patch: Partial<AuthorRow>) =>
    setAuthors((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const linkedElsewhere = (personId: number, exceptKey: number) =>
    authors.some((a) => a.key !== exceptKey && a.person_id === personId);

  const yearValid = form.year.trim() === '' || /^\d{3,4}$/.test(form.year.trim());
  const canSave = form.title.trim() && authors.some((a) => a.name.trim()) && yearValid;

  return (
    <Modal title={publication ? 'Edit publication' : 'Add publication'} onClose={onClose} wide>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          setYearError(!yearValid);
          if (canSave) save.mutate(undefined);
        }}
      >
        <Field label="Title *">
          <Input value={form.title} onChange={setField('title')} autoFocus />
        </Field>
        <div className="grid grid-cols-4 gap-3">
          <Field label="Year">
            <Input
              value={form.year}
              inputMode="numeric"
              onChange={(e) => {
                const digits = e.target.value.replace(/\D/g, '').slice(0, 4);
                setForm((f) => ({ ...f, year: digits }));
                setYearError(false);
              }}
              placeholder="2025"
            />
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
        {yearError && <p className="text-xs text-red-600">Year must be a 3–4 digit number.</p>}
        <div className="grid grid-cols-2 gap-3">
          <Field label="DOI">
            <Input value={form.doi} onChange={setField('doi')} placeholder="10.1000/xyz" />
          </Field>
          <Field label="URL">
            <Input value={form.url} onChange={setField('url')} placeholder="https://…" />
          </Field>
        </div>
        <div className="grid grid-cols-[1fr_auto_auto] items-end gap-3">
          <Field label="Language">
            <Input value={form.language} onChange={setField('language')} placeholder="cs / en" />
          </Field>
          <Field label="Reading status">
            <Select value={form.read_status} onChange={setField('read_status')}>
              {READ_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </Select>
          </Field>
          <label className="flex items-center gap-1.5 pb-1.5 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={form.starred}
              onChange={(e) => setForm((f) => ({ ...f, starred: e.target.checked }))}
            />
            ★ Starred
          </label>
        </div>
        <Field label="My note (why it matters, key takeaways…)">
          <TextArea value={form.note} onChange={setField('note')} rows={2} />
        </Field>
        <Field label="Abstract">
          <TextArea value={form.abstract} onChange={setField('abstract')} rows={2} />
        </Field>

        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs font-medium text-slate-600">
              Authors (in order; unlinked names become suggestions)
            </span>
            <Btn
              variant="ghost"
              onClick={() =>
                setAuthors((rows) => [
                  ...rows,
                  { key: nextKey(), name: '', person_id: null, autoFilledFrom: null },
                ])
              }
            >
              + author
            </Btn>
          </div>
          <div className="space-y-1.5">
            {authors.map((author, i) => (
              <div key={author.key} className="flex items-center gap-2">
                <span className="w-4 text-right text-xs text-slate-400">{i + 1}.</span>
                <Input
                  value={author.name}
                  onChange={(e) =>
                    updateAuthor(author.key, { name: e.target.value, autoFilledFrom: null })
                  }
                  placeholder="Author name as printed"
                  className="!flex-1"
                />
                <Select
                  value={author.person_id ?? ''}
                  onChange={(e) => {
                    const pid = e.target.value ? Number(e.target.value) : null;
                    const linked = (people.data ?? []).find((p) => p.id === pid);
                    // replace the name only when it's empty or was our own auto-fill
                    const replaceName =
                      !author.name.trim() || author.name === author.autoFilledFrom;
                    updateAuthor(author.key, {
                      person_id: pid,
                      name: replaceName && linked ? linked.name : author.name,
                      autoFilledFrom: replaceName && linked ? linked.name : author.autoFilledFrom,
                    });
                  }}
                  className="!w-48"
                >
                  <option value="">not linked</option>
                  {(people.data ?? []).map((p) => (
                    <option
                      key={p.id}
                      value={p.id}
                      disabled={p.id !== author.person_id && linkedElsewhere(p.id, author.key)}
                    >
                      {p.name}
                    </option>
                  ))}
                </Select>
                <Btn
                  variant="ghost"
                  onClick={() => setAuthors((rows) => rows.filter((r) => r.key !== author.key))}
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
