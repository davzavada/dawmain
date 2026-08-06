import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { usePeople, useTags } from '../api/queries';
import OrcidImportModal from '../components/OrcidImportModal';
import PersonDetail from '../components/PersonDetail';
import PersonForm from '../components/PersonForm';
import { Btn, Input, Loading, Select, TagChip } from '../components/ui';

export default function PeoplePage() {
  const { id } = useParams();
  const selectedId = id ? Number(id) : undefined;
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [tag, setTag] = useState('');
  const [adding, setAdding] = useState(false);
  const [addingOrcid, setAddingOrcid] = useState(false);
  const people = usePeople(search, tag);
  const tags = useTags();

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-slate-200 bg-white px-4 py-2.5">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search people…"
            className="!w-56"
          />
          <Select value={tag} onChange={(e) => setTag(e.target.value)} className="!w-44">
            <option value="">All tags</option>
            {(tags.data ?? []).map((t) => (
              <option key={t.id} value={t.name}>
                {t.name}
              </option>
            ))}
          </Select>
          <div className="flex-1" />
          <Btn variant="subtle" onClick={() => setAddingOrcid(true)}>
            Add from ORCID
          </Btn>
          <Btn onClick={() => setAdding(true)}>Add person</Btn>
        </div>

        {people.isLoading ? (
          <Loading />
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2 font-medium">Name</th>
                  <th className="px-4 py-2 font-medium">Affiliation</th>
                  <th className="px-4 py-2 font-medium">Tags</th>
                  <th className="px-2 py-2 text-right font-medium" title="Publications">
                    Pubs
                  </th>
                  <th className="px-2 py-2 text-right font-medium" title="Relations">
                    Rels
                  </th>
                </tr>
              </thead>
              <tbody>
                {(people.data ?? []).map((p) => (
                  <tr
                    key={p.id}
                    onClick={() => navigate(`/people/${p.id}`)}
                    className={`cursor-pointer border-t border-slate-100 hover:bg-slate-50 ${
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
                    <td className="px-2 py-2 text-right text-xs text-slate-500">
                      {p.publication_count}
                    </td>
                    <td className="px-2 py-2 text-right text-xs text-slate-500">
                      {p.relation_count}
                    </td>
                  </tr>
                ))}
                {(people.data ?? []).length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-sm text-slate-400">
                      No people yet. Add your first contact or import one from ORCID.
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
          <PersonDetail personId={selectedId} basePath="/people" />
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
