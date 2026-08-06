import { useState } from 'react';
import type { Person, PersonPatch } from '@crm/shared';
import { api, useAppMutation, usePeople } from '../api/queries';
import { Btn, ErrorText, Field, Input, Modal, Select, TextArea } from './ui';

interface Props {
  person?: Person;
  onClose: () => void;
  onSaved?: (person: Person) => void;
  /** called with the surviving person's id after a merge */
  onMerged?: (winnerId: number) => void;
}

export default function PersonForm({ person, onClose, onSaved, onMerged }: Props) {
  const [form, setForm] = useState({
    name: person?.name ?? '',
    titles: person?.titles ?? '',
    email: person?.email ?? '',
    website: person?.website ?? '',
    country: person?.country ?? '',
    orcid: person?.orcid ?? '',
    note: person?.note ?? '',
  });
  const [mergeTarget, setMergeTarget] = useState('');
  const people = usePeople('', '');

  const save = useAppMutation(
    async () => {
      const patch: PersonPatch & { name: string } = {
        name: form.name.trim(),
        titles: form.titles.trim() || null,
        email: form.email.trim() || null,
        website: form.website.trim() || null,
        country: form.country.trim() || null,
        orcid: form.orcid.trim() || null,
        note: form.note.trim() || null,
      };
      return person ? api.patchPerson({ id: person.id, patch }) : api.createPerson(patch);
    },
    (saved) => {
      onSaved?.(saved);
      onClose();
    },
  );

  const merge = useAppMutation(api.mergePerson, (result) => {
    onClose();
    onMerged?.(result.detail.person.id);
  });

  const set =
    (key: keyof typeof form) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setForm((f) => ({ ...f, [key]: e.target.value }));

  const mergeCandidates = (people.data ?? []).filter((p) => p.id !== person?.id);

  return (
    <Modal title={person ? `Edit ${person.name}` : 'Add person'} onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (form.name.trim()) save.mutate(undefined);
        }}
      >
        <Field label="Name *">
          <Input value={form.name} onChange={set('name')} placeholder="Jana Nováková" autoFocus />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Titles">
            <Input value={form.titles} onChange={set('titles')} placeholder="prof. JUDr., Ph.D." />
          </Field>
          <Field label="Country">
            <Input value={form.country} onChange={set('country')} placeholder="CZ" />
          </Field>
        </div>
        <Field label="Email">
          <Input value={form.email} onChange={set('email')} type="email" />
        </Field>
        <Field label="Website">
          <Input value={form.website} onChange={set('website')} placeholder="https://…" />
        </Field>
        <Field label="ORCID iD">
          <Input value={form.orcid} onChange={set('orcid')} placeholder="0000-0002-1825-0097" />
        </Field>
        <Field label="Note">
          <TextArea value={form.note} onChange={set('note')} rows={3} />
        </Field>
        <div className="flex justify-end gap-2 pt-1">
          <Btn variant="subtle" onClick={onClose}>
            Cancel
          </Btn>
          <Btn type="submit" disabled={!form.name.trim() || save.isPending}>
            {person ? 'Save' : 'Create'}
          </Btn>
        </div>
        <ErrorText error={save.error} />
      </form>

      {person && (
        <div className="mt-4 border-t border-slate-200 pt-3">
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Merge duplicate
          </h3>
          <p className="mb-2 text-xs text-slate-500">
            Moves all publications, affiliations, relations, interactions and tags of{' '}
            <span className="font-medium">{person.name}</span> onto the selected person, then
            deletes this entry.
          </p>
          <div className="flex items-center gap-2">
            <Select
              value={mergeTarget}
              onChange={(e) => setMergeTarget(e.target.value)}
              className="!w-56"
            >
              <option value="">— merge into… —</option>
              {mergeCandidates.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
            <Btn
              variant="danger"
              disabled={!mergeTarget || merge.isPending}
              onClick={() => {
                const target = mergeCandidates.find((p) => p.id === Number(mergeTarget));
                if (
                  target &&
                  confirm(`Merge ${person.name} into ${target.name}? This cannot be undone.`)
                ) {
                  merge.mutate({ id: person.id, into_id: target.id });
                }
              }}
            >
              Merge
            </Btn>
          </div>
          <ErrorText error={merge.error} />
        </div>
      )}
    </Modal>
  );
}
