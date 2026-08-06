import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { PeopleSort } from '@crm/shared';
import { usePeople, useTags } from '../api/queries';
import { useDebouncedValue } from '../hooks';
import OrcidImportModal from '../components/OrcidImportModal';
import PersonDetail from '../components/PersonDetail';
import PersonForm from '../components/PersonForm';
import { Btn, Input, LoadState, Select, TagChip } from '../components/ui';

function parseId(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : undefined;
}

export default function PeoplePage() {
  const { id } = useParams();
  const selectedId = parseId(id);
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [tag, setTag] = useState('');
  const [sort, setSort] = useState<PeopleSort>('name');
  const [adding, setAdding] = useState(false);
  const [addingOrcid, setAddingOrcid] = useState(false);
  const debouncedSearch = useDebouncedValue(search);
  const people = usePeople(debouncedSearch, tag, sort);
  const tags = useTags();

  // a malformed id in the URL (e.g. #/people/abc) is treated as no selection
  useEffect(() => {
    if (id !== undefined && selectedId === undefined) {
      navigate('/people', { replace: true });
    }
  }, [id, selectedId, navigate]);

  const filtered = debouncedSearch.trim() !== '' || tag !== '';
  const rows = people.data ?? [];

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-slate-200 bg-white px-4 py-2.5">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, email, note, institution…"
            className="!w-64"
          />
          <Select value={tag} onChange={(e) => setTag(e.target.value)} className="!w-40">
            <option value="">All tags</option>
            {(tags.data ?? []).map((t) => (
              <option key={t.id} value={t.name}>
                {t.name} ({t.person_count})
              </option>
            ))}
          </Select>
          <Select
            value={sort}
            onChange={(e) => setSort(e.target.value as PeopleSort)}
            className="!w-44"
            title="Sort order"
          >
            <option value="name">Sort: name</option>
            <option value="recent">Sort: recently contacted</option>
            <option value="stale">Sort: longest silent</option>
          </Select>
          <div className="flex-1" />
          <Btn variant="subtle" onClick={() => setAddingOrcid(true)}>
            Add from ORCID
          </Btn>
          <Btn onClick={() => setAdding(true)}>Add person</Btn>
        </div>

        <LoadState
          isLoading={people.isLoading}
          isError={people.isError}
          error={people.error}
          onRetry={() => void people.refetch()}
        />
        {!people.isLoading && !people.isError && (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2 font-medium">Name</th>
                  <th className="px-4 py-2 font-medium">Affiliation</th>
                  <th className="px-4 py-2 font-medium">Tags</th>
                  <th className="px-3 py-2 font-medium">Last contact</th>
                  <th className="px-2 py-2 text-right font-medium" title="Publications">
                    Pubs
                  </th>
                  <th className="px-2 py-2 text-right font-medium" title="Relations">
                    Rels
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr
                    key={p.id}
                    onClick={() => navigate(`/people/${p.id}`)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') navigate(`/people/${p.id}`);
                    }}
                    tabIndex={0}
                    className={`cursor-pointer border-t border-slate-100 hover:bg-slate-50 focus:bg-slate-100 focus:outline-none ${
                      p.id === selectedId ? 'bg-blue-50 hover:bg-blue-50' : ''
                    }`}
                  >
                    <td className="px-4 py-2">
                      <div className="font-medium">{p.name}</div>
                      {p.titles && <div className="text-xs text-slate-400">{p.titles}</div>}
                    </td>
                    <td className="px-4 py-2 text-xs text-slate-500">{p.affiliations}</td>
                    <td className="px-4 py-2">
                      <div className="flex flex-wrap gap-1">
                        {p.tags.map((t) => (
                          <TagChip key={t} name={t} />
                        ))}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-500">
                      {p.last_contact ?? <span className="text-slate-300">never</span>}
                    </td>
                    <td className="px-2 py-2 text-right text-xs text-slate-500">
                      {p.publication_count}
                    </td>
                    <td className="px-2 py-2 text-right text-xs text-slate-500">
                      {p.relation_count}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-sm text-slate-400">
                      {filtered
                        ? 'No people match this search or tag filter.'
                        : 'No people yet. Add your first contact or import one from ORCID.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {selectedId !== undefined && (
        <aside className="w-[26rem] shrink-0 border-l border-slate-200 bg-white">
          <PersonDetail
            key={selectedId}
            personId={selectedId}
            onClose={() => navigate('/people')}
          />
        </aside>
      )}

      {adding && (
        <PersonForm onClose={() => setAdding(false)} onSaved={(p) => navigate(`/people/${p.id}`)} />
      )}
      {addingOrcid && (
        <OrcidImportModal
          onClose={() => setAddingOrcid(false)}
          onCreated={(personId) => navigate(`/people/${personId}`)}
        />
      )}
    </div>
  );
}
