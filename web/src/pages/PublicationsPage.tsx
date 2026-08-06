import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { PublicationListItem, ReadStatus } from '@crm/shared';
import { api, useAppMutation, usePerson, usePublications } from '../api/queries';
import { useDebouncedValue } from '../hooks';
import PublicationForm from '../components/PublicationForm';
import SuggestionsInbox from '../components/SuggestionsInbox';
import { Btn, Input, LoadState } from '../components/ui';

type Shelf = 'all' | 'starred' | 'to_read' | 'read';

const SHELVES: { value: Shelf; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'starred', label: '★ Starred' },
  { value: 'to_read', label: 'To read' },
  { value: 'read', label: 'Read' },
];

const NEXT_STATUS: Record<ReadStatus, ReadStatus> = {
  none: 'to_read',
  to_read: 'read',
  read: 'none',
};

const STATUS_BADGE: Record<ReadStatus, { label: string; className: string }> = {
  none: { label: '·', className: 'text-slate-300 hover:text-slate-500' },
  to_read: { label: 'to read', className: 'bg-sky-100 text-sky-700 hover:bg-sky-200' },
  read: { label: 'read', className: 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200' },
};

export default function PublicationsPage() {
  const [search, setSearch] = useState('');
  const [shelf, setShelf] = useState<Shelf>('all');
  const [editing, setEditing] = useState<PublicationListItem | 'new' | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const personParam = searchParams.get('person');
  const personId =
    personParam && Number.isInteger(Number(personParam)) && Number(personParam) > 0
      ? Number(personParam)
      : undefined;
  const filterPerson = usePerson(personId);

  const debouncedSearch = useDebouncedValue(search);
  const publications = usePublications({
    search: debouncedSearch,
    person_id: personId,
    starred: shelf === 'starred',
    read_status: shelf === 'to_read' || shelf === 'read' ? shelf : '',
  });
  const patch = useAppMutation(api.patchPublication);
  const deletePublication = useAppMutation(api.deletePublication);

  const filtered = debouncedSearch.trim() !== '' || shelf !== 'all' || personId !== undefined;
  const rows = publications.data ?? [];

  return (
    <div className="flex h-full flex-col">
      <SuggestionsInbox />
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-4 py-2.5">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search title, venue or author…"
          className="!w-64"
        />
        <div className="flex gap-1">
          {SHELVES.map((s) => (
            <button
              key={s.value}
              type="button"
              onClick={() => setShelf(s.value)}
              className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                shelf === s.value
                  ? 'bg-slate-900 text-white'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
        {personId !== undefined && (
          <span className="flex items-center gap-1 rounded-full bg-blue-100 px-2.5 py-1 text-xs text-blue-800">
            by {filterPerson.data?.person.name ?? `#${personId}`}
            <button
              type="button"
              onClick={() => setSearchParams({})}
              aria-label="Clear person filter"
              className="hover:text-blue-950"
            >
              ×
            </button>
          </span>
        )}
        <div className="flex-1" />
        <Btn onClick={() => setEditing('new')}>Add publication</Btn>
      </div>

      <LoadState
        isLoading={publications.isLoading}
        isError={publications.isError}
        error={publications.error}
        onRetry={() => void publications.refetch()}
      />
      {!publications.isLoading && !publications.isError && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="w-8 px-2 py-2" title="Starred">
                  ★
                </th>
                <th className="px-2 py-2 font-medium">Title</th>
                <th className="px-2 py-2 font-medium">Status</th>
                <th className="px-2 py-2 font-medium">Year</th>
                <th className="px-4 py-2 font-medium">Venue</th>
                <th className="px-4 py-2 font-medium">Authors</th>
                <th className="px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} className="group border-t border-slate-100 hover:bg-slate-50">
                  <td className="px-2 py-2">
                    <button
                      type="button"
                      onClick={() => patch.mutate({ id: p.id, patch: { starred: !p.starred } })}
                      className={`text-base leading-none ${
                        p.starred ? 'text-amber-500' : 'text-slate-200 hover:text-amber-400'
                      }`}
                      title={p.starred ? 'Unstar' : 'Star — papers you like'}
                    >
                      ★
                    </button>
                  </td>
                  <td className="px-2 py-2">
                    <span className="font-medium">{p.title}</span>
                    <span className="ml-1 text-xs text-slate-400">{p.type.replace('_', ' ')}</span>
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
                    {p.note && (
                      <div className="mt-0.5 text-xs italic text-slate-500">{p.note}</div>
                    )}
                  </td>
                  <td className="px-2 py-2">
                    <button
                      type="button"
                      onClick={() =>
                        patch.mutate({ id: p.id, patch: { read_status: NEXT_STATUS[p.read_status] } })
                      }
                      className={`rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors ${STATUS_BADGE[p.read_status].className}`}
                      title="Click to cycle: — → to read → read"
                    >
                      {STATUS_BADGE[p.read_status].label}
                    </button>
                  </td>
                  <td className="px-2 py-2 text-xs text-slate-500">{p.year ?? ''}</td>
                  <td className="px-4 py-2 text-xs text-slate-500">{p.venue ?? ''}</td>
                  <td className="px-4 py-2 text-xs">
                    {p.authors.map((a, i) => (
                      <span key={`${p.id}-${a.position}`}>
                        {i > 0 && ', '}
                        {a.person_id ? (
                          <Link
                            className="text-blue-700 hover:underline"
                            to={`/people/${a.person_id}`}
                          >
                            {a.name}
                          </Link>
                        ) : (
                          <span className="text-slate-500" title="Not a contact yet">
                            {a.name}
                          </span>
                        )}
                      </span>
                    ))}
                  </td>
                  <td className="px-2 py-2 text-right">
                    <span className="invisible flex justify-end gap-1 group-hover:visible">
                      <Btn variant="ghost" onClick={() => setEditing(p)}>
                        Edit
                      </Btn>
                      <Btn
                        variant="ghost"
                        onClick={() => {
                          if (confirm(`Delete "${p.title}"?`)) deletePublication.mutate(p.id);
                        }}
                      >
                        Delete
                      </Btn>
                    </span>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-sm text-slate-400">
                    {filtered ? 'No publications match these filters.' : 'No publications yet.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <PublicationForm
          publication={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
