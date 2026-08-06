import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { PublicationListItem } from '@crm/shared';
import { api, useAppMutation, usePublications } from '../api/queries';
import PublicationForm from '../components/PublicationForm';
import SuggestionsInbox from '../components/SuggestionsInbox';
import { Btn, Input, Loading } from '../components/ui';

export default function PublicationsPage() {
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<PublicationListItem | 'new' | null>(null);
  const publications = usePublications(search);
  const deletePublication = useAppMutation(api.deletePublication);

  return (
    <div className="flex h-full flex-col">
      <SuggestionsInbox />
      <div className="flex items-center gap-2 border-b border-slate-200 bg-white px-4 py-2.5">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search title or venue…"
          className="!w-64"
        />
        <div className="flex-1" />
        <Btn onClick={() => setEditing('new')}>Add publication</Btn>
      </div>

      {publications.isLoading ? (
        <Loading />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2 font-medium">Title</th>
                <th className="px-2 py-2 font-medium">Year</th>
                <th className="px-4 py-2 font-medium">Venue</th>
                <th className="px-4 py-2 font-medium">Authors</th>
                <th className="px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {(publications.data ?? []).map((p) => (
                <tr key={p.id} className="group border-t border-slate-100 hover:bg-slate-50">
                  <td className="px-4 py-2">
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
              {(publications.data ?? []).length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-sm text-slate-400">
                    No publications yet.
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
