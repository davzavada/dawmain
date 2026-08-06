import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { relationLabel } from '@crm/shared';
import { api, useAppMutation, usePerson } from '../api/queries';
import AffiliationForm from './AffiliationForm';
import OrcidImportModal from './OrcidImportModal';
import PersonForm from './PersonForm';
import RelationForm from './RelationForm';
import TagEditor from './TagEditor';
import { Btn, EmptyState, ErrorText, Loading, Section } from './ui';

interface Props {
  personId: number;
  basePath: '/people' | '/network';
}

export default function PersonDetail({ personId, basePath }: Props) {
  const navigate = useNavigate();
  const detail = usePerson(personId);
  const [editing, setEditing] = useState(false);
  const [addingAffiliation, setAddingAffiliation] = useState(false);
  const [addingRelation, setAddingRelation] = useState(false);
  const [orcidOpen, setOrcidOpen] = useState(false);

  const deletePerson = useAppMutation(api.deletePerson, () => navigate(basePath));
  const deleteAffiliation = useAppMutation(api.deleteAffiliation);
  const deleteRelation = useAppMutation(api.deleteRelation);

  if (detail.isLoading) return <Loading />;
  if (detail.isError) return <ErrorText error={detail.error} />;
  if (!detail.data) return null;

  const { person, tags, affiliations, publications, relations, coauthors } = detail.data;

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="px-4 py-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold leading-tight">{person.name}</h2>
            {person.titles && <p className="text-xs text-slate-500">{person.titles}</p>}
          </div>
          <div className="flex shrink-0 gap-1">
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
          {affiliations.map((a) => (
            <li key={a.id} className="group flex items-baseline justify-between gap-2 text-sm">
              <div>
                <span className="font-medium">{a.institution.short_name ?? a.institution.name}</span>
                {a.role && <span className="text-slate-500"> — {a.role}</span>}
                <span className="ml-1 text-xs text-slate-400">
                  {a.start_date ?? ''}
                  {(a.start_date || a.end_date) && '–'}
                  {a.end_date ?? (a.start_date ? 'now' : '')}
                </span>
              </div>
              <button
                type="button"
                onClick={() => deleteAffiliation.mutate(a.id)}
                className="invisible text-xs text-slate-400 hover:text-red-600 group-hover:visible"
              >
                remove
              </button>
            </li>
          ))}
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
          {relations.map((r) => (
            <li key={`${r.id}-${r.direction}`} className="group flex items-baseline justify-between gap-2 text-sm">
              <div>
                <span className="text-xs text-slate-500">
                  {r.direction === 'out' ? relationLabel(r.type) : `${relationLabel(r.type)} (incoming)`}
                  {' → '}
                </span>
                <Link className="font-medium text-blue-700 hover:underline" to={`${basePath}/${r.other.id}`}>
                  {r.other.name}
                </Link>
                {r.date && <span className="ml-1 text-xs text-slate-400">{r.date}</span>}
                {r.note && <span className="ml-1 text-xs text-slate-400">· {r.note}</span>}
              </div>
              <button
                type="button"
                onClick={() => deleteRelation.mutate(r.id)}
                className="invisible text-xs text-slate-400 hover:text-red-600 group-hover:visible"
              >
                remove
              </button>
            </li>
          ))}
        </ul>
      </Section>

      {coauthors.length > 0 && (
        <Section title="Co-authors">
          <div className="flex flex-wrap gap-1.5">
            {coauthors.map((c) => (
              <Link
                key={c.person_id}
                to={`${basePath}/${c.person_id}`}
                className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700 hover:bg-slate-200"
              >
                {c.name} · {c.shared_count}
              </Link>
            ))}
          </div>
        </Section>
      )}

      <Section title={`Publications (${publications.length})`}>
        {publications.length === 0 && <EmptyState>No publications recorded.</EmptyState>}
        <ul className="space-y-2">
          {publications.map((p) => (
            <li key={p.id} className="text-sm">
              <span className="font-medium">{p.title}</span>
              <span className="text-xs text-slate-500">
                {p.year ? ` (${p.year})` : ''}
                {p.venue ? ` · ${p.venue}` : ''}
              </span>
              {p.coauthors.length > 0 && (
                <div className="text-xs text-slate-400">
                  with{' '}
                  {p.coauthors.map((c, i) => (
                    <span key={`${p.id}-${c.name}-${i}`}>
                      {i > 0 && ', '}
                      {c.person_id ? (
                        <Link className="text-blue-700 hover:underline" to={`${basePath}/${c.person_id}`}>
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
      </Section>

      {person.note && (
        <Section title="Note">
          <p className="whitespace-pre-wrap text-sm text-slate-700">{person.note}</p>
        </Section>
      )}

      {editing && <PersonForm person={person} onClose={() => setEditing(false)} />}
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
