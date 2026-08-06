import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { RELATION_TYPES, relationColor, relationLabel } from '@crm/shared';
import { ApiError } from '../api/client';
import { api, useAppMutation, usePerson } from '../api/queries';
import AffiliationForm from './AffiliationForm';
import InteractionsSection from './InteractionsSection';
import OrcidImportModal from './OrcidImportModal';
import PersonForm from './PersonForm';
import PublicationForm from './PublicationForm';
import RelationForm from './RelationForm';
import TagEditor from './TagEditor';
import { Btn, EmptyState, ErrorText, Field, Input, Loading, Section, Select } from './ui';

interface Props {
  personId: number;
  onClose: () => void;
}

function RelationEditRow({
  relation,
  onDone,
}: {
  relation: { id: number; type: string; date: string | null; note: string | null };
  onDone: () => void;
}) {
  const [form, setForm] = useState({
    type: relation.type,
    date: relation.date ?? '',
    note: relation.note ?? '',
  });
  const save = useAppMutation(api.patchRelation, onDone);
  return (
    <form
      className="space-y-2 rounded-md bg-slate-50 p-2"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate({
          id: relation.id,
          patch: {
            type: form.type,
            date: form.date.trim() || null,
            note: form.note.trim() || null,
          },
        });
      }}
    >
      <div className="grid grid-cols-3 gap-2">
        <Field label="Type">
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
        <Field label="Date">
          <Input
            value={form.date}
            onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
          />
        </Field>
        <Field label="Note">
          <Input
            value={form.note}
            onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
          />
        </Field>
      </div>
      <div className="flex justify-end gap-2">
        <Btn variant="subtle" onClick={onDone}>
          Cancel
        </Btn>
        <Btn type="submit" disabled={save.isPending}>
          Save
        </Btn>
      </div>
      <ErrorText error={save.error} />
    </form>
  );
}

function AffiliationEditRow({
  affiliation,
  onDone,
}: {
  affiliation: { id: number; role: string | null; start_date: string | null; end_date: string | null };
  onDone: () => void;
}) {
  const [form, setForm] = useState({
    role: affiliation.role ?? '',
    start: affiliation.start_date ?? '',
    end: affiliation.end_date ?? '',
  });
  const save = useAppMutation(api.patchAffiliation, onDone);
  return (
    <form
      className="space-y-2 rounded-md bg-slate-50 p-2"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate({
          id: affiliation.id,
          patch: {
            role: form.role.trim() || null,
            start_date: form.start.trim() || null,
            end_date: form.end.trim() || null,
          },
        });
      }}
    >
      <div className="grid grid-cols-3 gap-2">
        <Field label="Role">
          <Input
            value={form.role}
            onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}
          />
        </Field>
        <Field label="From">
          <Input
            value={form.start}
            onChange={(e) => setForm((f) => ({ ...f, start: e.target.value }))}
          />
        </Field>
        <Field label="To (empty = current)">
          <Input value={form.end} onChange={(e) => setForm((f) => ({ ...f, end: e.target.value }))} />
        </Field>
      </div>
      <div className="flex justify-end gap-2">
        <Btn variant="subtle" onClick={onDone}>
          Cancel
        </Btn>
        <Btn type="submit" disabled={save.isPending}>
          Save
        </Btn>
      </div>
      <ErrorText error={save.error} />
    </form>
  );
}

export default function PersonDetail({ personId, onClose }: Props) {
  const navigate = useNavigate();
  const detail = usePerson(personId);
  const [editing, setEditing] = useState(false);
  const [addingAffiliation, setAddingAffiliation] = useState(false);
  const [editingAffiliationId, setEditingAffiliationId] = useState<number | null>(null);
  const [addingRelation, setAddingRelation] = useState(false);
  const [editingRelationId, setEditingRelationId] = useState<number | null>(null);
  const [addingPublication, setAddingPublication] = useState(false);
  const [orcidOpen, setOrcidOpen] = useState(false);

  const deletePerson = useAppMutation(api.deletePerson, () => navigate('/people'));
  const deleteAffiliation = useAppMutation(api.deleteAffiliation);
  const deleteRelation = useAppMutation(api.deleteRelation);
  const toggleStar = useAppMutation(api.patchPublication);

  if (detail.isLoading) return <Loading />;
  if (detail.isError) {
    const notFound = detail.error instanceof ApiError && detail.error.status === 404;
    return (
      <div className="p-4 text-sm">
        <p className="text-slate-500">
          {notFound ? 'This person no longer exists.' : `Could not load: ${String(detail.error)}`}
        </p>
        <div className="mt-2">
          <Btn variant="subtle" onClick={onClose}>
            Back to list
          </Btn>
        </div>
      </div>
    );
  }
  if (!detail.data) return null;

  const { person, tags, affiliations, interactions, publications, relations, coauthors } =
    detail.data;

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="px-4 py-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold leading-tight">{person.name}</h2>
            {person.titles && <p className="text-xs text-slate-500">{person.titles}</p>}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Btn variant="subtle" onClick={() => setEditing(true)}>
              Edit
            </Btn>
            <Btn
              variant="danger"
              onClick={() => {
                if (confirm(`Delete ${person.name}? Relations and affiliations go with them.`)) {
                  deletePerson.mutate(person.id);
                }
              }}
            >
              Delete
            </Btn>
            <button
              type="button"
              onClick={onClose}
              className="ml-1 px-1 text-slate-400 hover:text-slate-700"
              aria-label="Close panel"
            >
              ✕
            </button>
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600">
          {person.country && <span>{person.country}</span>}
          {person.email && (
            <a className="text-blue-700 hover:underline" href={`mailto:${person.email}`}>
              {person.email}
            </a>
          )}
          {person.website && (
            <a
              className="text-blue-700 hover:underline"
              href={person.website}
              target="_blank"
              rel="noreferrer"
            >
              website
            </a>
          )}
          {person.orcid && (
            <a
              className="text-blue-700 hover:underline"
              href={`https://orcid.org/${person.orcid}`}
              target="_blank"
              rel="noreferrer"
            >
              ORCID {person.orcid}
            </a>
          )}
          {person.source !== 'manual' && (
            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] uppercase text-slate-500">
              {person.source}
            </span>
          )}
        </div>
        {person.orcid && (
          <div className="mt-2">
            <Btn variant="subtle" onClick={() => setOrcidOpen(true)}>
              Complete from ORCID
            </Btn>
          </div>
        )}
        <ErrorText error={deletePerson.error} />
      </div>

      <Section title="Interactions">
        <InteractionsSection personId={person.id} interactions={interactions} />
      </Section>

      <Section title="Tags">
        <TagEditor personId={person.id} tags={tags} />
      </Section>

      <Section
        title="Affiliations"
        action={
          <Btn variant="ghost" onClick={() => setAddingAffiliation((v) => !v)}>
            + add
          </Btn>
        }
      >
        {addingAffiliation && (
          <div className="mb-2">
            <AffiliationForm personId={person.id} onDone={() => setAddingAffiliation(false)} />
          </div>
        )}
        {affiliations.length === 0 && !addingAffiliation && (
          <EmptyState>No affiliations yet.</EmptyState>
        )}
        <ul className="space-y-1.5">
          {affiliations.map((a) =>
            editingAffiliationId === a.id ? (
              <li key={a.id}>
                <AffiliationEditRow affiliation={a} onDone={() => setEditingAffiliationId(null)} />
              </li>
            ) : (
              <li key={a.id} className="group flex items-baseline justify-between gap-2 text-sm">
                <div>
                  <span className="font-medium">
                    {a.institution.short_name ?? a.institution.name}
                  </span>
                  {a.role && <span className="text-slate-500"> — {a.role}</span>}
                  <span className="ml-1 text-xs text-slate-400">
                    {a.start_date ?? ''}
                    {(a.start_date || a.end_date) && '–'}
                    {a.end_date ?? (a.start_date ? 'now' : '')}
                  </span>
                </div>
                <span className="invisible flex shrink-0 gap-1.5 group-hover:visible">
                  <button
                    type="button"
                    onClick={() => setEditingAffiliationId(a.id)}
                    className="text-xs text-slate-400 hover:text-slate-700"
                  >
                    edit
                  </button>
                  <button
                    type="button"
                    onClick={() => deleteAffiliation.mutate(a.id)}
                    className="text-xs text-slate-400 hover:text-red-600"
                  >
                    remove
                  </button>
                </span>
              </li>
            ),
          )}
        </ul>
      </Section>

      <Section
        title="Relations"
        action={
          <Btn variant="ghost" onClick={() => setAddingRelation((v) => !v)}>
            + add
          </Btn>
        }
      >
        {addingRelation && (
          <div className="mb-2">
            <RelationForm personId={person.id} onDone={() => setAddingRelation(false)} />
          </div>
        )}
        {relations.length === 0 && !addingRelation && <EmptyState>No relations yet.</EmptyState>}
        <ul className="space-y-1.5">
          {relations.map((r) =>
            editingRelationId === r.id ? (
              <li key={`${r.id}-edit`}>
                <RelationEditRow relation={r} onDone={() => setEditingRelationId(null)} />
              </li>
            ) : (
              <li
                key={`${r.id}-${r.direction}`}
                className="group flex items-baseline justify-between gap-2 text-sm"
              >
                <div className="flex flex-wrap items-baseline gap-x-1.5">
                  <span
                    className="rounded-full px-1.5 py-0.5 text-[10px] font-medium text-white"
                    style={{ backgroundColor: relationColor(r.type) }}
                  >
                    {relationLabel(r.type)}
                    {r.direction === 'in' ? ' ←' : ''}
                  </span>
                  <Link
                    className="font-medium text-blue-700 hover:underline"
                    to={`/people/${r.other.id}`}
                  >
                    {r.other.name}
                  </Link>
                  {r.date && <span className="text-xs text-slate-400">{r.date}</span>}
                  {r.note && <span className="text-xs text-slate-400">· {r.note}</span>}
                </div>
                <span className="invisible flex shrink-0 gap-1.5 group-hover:visible">
                  <button
                    type="button"
                    onClick={() => setEditingRelationId(r.id)}
                    className="text-xs text-slate-400 hover:text-slate-700"
                  >
                    edit
                  </button>
                  <button
                    type="button"
                    onClick={() => deleteRelation.mutate(r.id)}
                    className="text-xs text-slate-400 hover:text-red-600"
                  >
                    remove
                  </button>
                </span>
              </li>
            ),
          )}
        </ul>
      </Section>

      {coauthors.length > 0 && (
        <Section title="Co-authors">
          <div className="flex flex-wrap gap-1.5">
            {coauthors.map((c) => (
              <Link
                key={c.person_id}
                to={`/people/${c.person_id}`}
                className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700 hover:bg-slate-200"
              >
                {c.name} · {c.shared_count}
              </Link>
            ))}
          </div>
        </Section>
      )}

      <Section
        title={`Publications (${publications.length})`}
        action={
          <Btn variant="ghost" onClick={() => setAddingPublication(true)}>
            + add
          </Btn>
        }
      >
        {publications.length === 0 && <EmptyState>No publications recorded.</EmptyState>}
        <ul className="space-y-2">
          {publications.map((p) => (
            <li key={p.id} className="text-sm">
              <button
                type="button"
                onClick={() =>
                  toggleStar.mutate({ id: p.id, patch: { starred: !p.starred } })
                }
                className={`mr-1 ${p.starred ? 'text-amber-500' : 'text-slate-300 hover:text-amber-400'}`}
                title={p.starred ? 'Unstar' : 'Star'}
              >
                ★
              </button>
              <span className="font-medium">{p.title}</span>
              <span className="text-xs text-slate-500">
                {p.year ? ` (${p.year})` : ''}
                {p.venue ? ` · ${p.venue}` : ''}
              </span>
              {p.doi && (
                <a
                  className="ml-1 text-xs text-blue-700 hover:underline"
                  href={`https://doi.org/${p.doi}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  doi
                </a>
              )}
              {p.url && (
                <a
                  className="ml-1 text-xs text-blue-700 hover:underline"
                  href={p.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  link
                </a>
              )}
              {p.coauthors.length > 0 && (
                <div className="pl-5 text-xs text-slate-400">
                  with{' '}
                  {p.coauthors.map((c, i) => (
                    <span key={`${p.id}-${c.name}-${i}`}>
                      {i > 0 && ', '}
                      {c.person_id ? (
                        <Link
                          className="text-blue-700 hover:underline"
                          to={`/people/${c.person_id}`}
                        >
                          {c.name}
                        </Link>
                      ) : (
                        c.name
                      )}
                    </span>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
        {publications.length > 0 && (
          <div className="mt-2">
            <Link
              to={`/publications?person=${person.id}`}
              className="text-xs text-blue-700 hover:underline"
            >
              show all in Publications →
            </Link>
          </div>
        )}
      </Section>

      {person.note && (
        <Section title="Note">
          <p className="whitespace-pre-wrap text-sm text-slate-700">{person.note}</p>
        </Section>
      )}

      {editing && (
        <PersonForm
          person={person}
          onClose={() => setEditing(false)}
          onMerged={(winnerId) => navigate(`/people/${winnerId}`)}
        />
      )}
      {addingPublication && (
        <PublicationForm
          presetAuthors={[{ name: person.name, person_id: person.id }]}
          onClose={() => setAddingPublication(false)}
        />
      )}
      {orcidOpen && person.orcid && (
        <OrcidImportModal
          personId={person.id}
          presetOrcid={person.orcid}
          onClose={() => setOrcidOpen(false)}
        />
      )}
    </div>
  );
}
