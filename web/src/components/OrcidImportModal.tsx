import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { normalizeOrcid, type OrcidImportCounts, type OrcidPreview } from '@crm/shared';
import { api, useAppMutation, usePeople } from '../api/queries';
import { Btn, ErrorText, Field, Input, Modal } from './ui';

interface Props {
  /** When set, imports into this person; otherwise creates a new person. */
  personId?: number;
  presetOrcid?: string;
  onClose: () => void;
  onCreated?: (personId: number) => void;
}

export default function OrcidImportModal({ personId, presetOrcid, onClose, onCreated }: Props) {
  const [orcid, setOrcid] = useState(presetOrcid ?? '');
  const [preview, setPreview] = useState<OrcidPreview | null>(null);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<unknown>(null);
  const [name, setName] = useState('');
  const [fieldChecks, setFieldChecks] = useState({ website: true, country: true });
  const [affChecks, setAffChecks] = useState<boolean[]>([]);
  const [pubChecks, setPubChecks] = useState<boolean[]>([]);
  const [done, setDone] = useState<OrcidImportCounts | null>(null);
  const requestSeq = useRef(0);
  const people = usePeople('', '');

  const loadPreview = async (id: string) => {
    if (fetching) return;
    const seq = ++requestSeq.current;
    setFetching(true);
    setFetchError(null);
    try {
      const data = await api.orcidPreview(id.trim());
      if (seq !== requestSeq.current) return;
      setPreview(data);
      setName(data.person.name ?? '');
      setAffChecks(data.affiliations.map(() => true));
      setPubChecks(data.publications.map((p) => !p.already_imported));
    } catch (err) {
      if (seq === requestSeq.current) setFetchError(err);
    } finally {
      if (seq === requestSeq.current) setFetching(false);
    }
  };

  const initialized = useRef(false);
  useEffect(() => {
    if (presetOrcid && !initialized.current) {
      initialized.current = true;
      void loadPreview(presetOrcid);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetOrcid]);

  // early duplicate check for the add-new flow
  const normalizedInput = preview ? preview.orcid : normalizeOrcid(orcid) ?? '';
  const existingPerson =
    personId === undefined && normalizedInput
      ? (people.data ?? []).find((p) => p.orcid === normalizedInput)
      : undefined;

  const doImport = useAppMutation(
    async () => {
      if (!preview) throw new Error('No preview loaded');
      const fields: Record<string, string> = {};
      if (fieldChecks.website && preview.person.website) fields.website = preview.person.website;
      if (fieldChecks.country && preview.person.country) fields.country = preview.person.country;
      const affiliations = preview.affiliations.filter((_, i) => affChecks[i]);
      const publications = preview.publications
        .filter((_, i) => pubChecks[i] && !preview.publications[i].already_imported)
        .map(({ already_imported: _ignored, ...rest }) => rest);
      if (personId !== undefined) {
        // make sure the iD itself lands on the person (fill-blank semantics)
        fields.orcid = preview.orcid;
        return api.orcidImport({ personId, input: { fields, affiliations, publications } });
      }
      return api.fromOrcid({
        orcid: preview.orcid,
        name: name.trim(),
        fields,
        affiliations,
        publications,
      });
    },
    (result) => {
      setDone(result.imported);
      if (personId === undefined) onCreated?.(result.detail.person.id);
    },
  );

  const checkbox = (checked: boolean, onChange: (v: boolean) => void, disabled = false) => (
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
      className="mt-0.5 shrink-0"
    />
  );

  return (
    <Modal
      title={personId !== undefined ? 'Complete profile from ORCID' : 'Add person from ORCID'}
      onClose={onClose}
      wide
    >
      {done ? (
        <div className="space-y-3">
          <p className="text-sm text-slate-700">
            Imported <span className="font-semibold">{done.publications}</span> publication
            {done.publications === 1 ? '' : 's'},{' '}
            <span className="font-semibold">{done.affiliations}</span> affiliation
            {done.affiliations === 1 ? '' : 's'} and{' '}
            <span className="font-semibold">{done.fields}</span> profile field
            {done.fields === 1 ? '' : 's'}.
          </p>
          <div className="flex justify-end">
            <Btn onClick={onClose}>Close</Btn>
          </div>
        </div>
      ) : (
        <>
          {!preview && !fetching && (
            <form
              className="flex items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (orcid.trim()) void loadPreview(orcid);
              }}
            >
              <div className="flex-1">
                <Field label="ORCID iD or URL">
                  <Input
                    value={orcid}
                    onChange={(e) => setOrcid(e.target.value)}
                    placeholder="0000-0002-1825-0097"
                    autoFocus
                  />
                </Field>
              </div>
              <Btn type="submit" disabled={!orcid.trim() || fetching}>
                Fetch
              </Btn>
            </form>
          )}
          {fetching && <p className="text-sm text-slate-400">Fetching ORCID record…</p>}
          <ErrorText error={fetchError} />

          {preview && !fetching && (
            <div className="space-y-4">
              <div className="flex items-start justify-between rounded-md bg-slate-50 p-3">
                <div>
                  <p className="text-sm">
                    <span className="font-semibold">
                      {preview.person.name ?? '(name not public)'}
                    </span>{' '}
                    <a
                      className="text-xs text-blue-700 hover:underline"
                      href={`https://orcid.org/${preview.orcid}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {preview.orcid}
                    </a>
                  </p>
                  {preview.person.keywords.length > 0 && (
                    <p className="mt-1 text-xs text-slate-500">
                      Keywords: {preview.person.keywords.join(', ')}
                    </p>
                  )}
                </div>
                {!presetOrcid && (
                  <Btn
                    variant="ghost"
                    onClick={() => {
                      setPreview(null);
                      setFetchError(null);
                    }}
                  >
                    Change iD
                  </Btn>
                )}
              </div>

              {existingPerson && (
                <p className="rounded-md bg-amber-50 p-2 text-xs text-amber-800">
                  This ORCID iD already belongs to{' '}
                  <Link
                    to={`/people/${existingPerson.id}`}
                    onClick={onClose}
                    className="font-medium underline"
                  >
                    {existingPerson.name}
                  </Link>{' '}
                  — open their profile and use “Complete from ORCID” instead.
                </p>
              )}

              {personId === undefined && (
                <Field label="Name for the new contact *">
                  <Input value={name} onChange={(e) => setName(e.target.value)} />
                </Field>
              )}

              <div>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Profile fields
                </h3>
                <div className="space-y-1 text-sm">
                  {preview.person.website && (
                    <label className="flex items-start gap-2">
                      {checkbox(fieldChecks.website, (v) =>
                        setFieldChecks((f) => ({ ...f, website: v })),
                      )}
                      <span>
                        Website: <span className="text-slate-600">{preview.person.website}</span>
                      </span>
                    </label>
                  )}
                  {preview.person.country && (
                    <label className="flex items-start gap-2">
                      {checkbox(fieldChecks.country, (v) =>
                        setFieldChecks((f) => ({ ...f, country: v })),
                      )}
                      <span>
                        Country: <span className="text-slate-600">{preview.person.country}</span>
                      </span>
                    </label>
                  )}
                  {!preview.person.website && !preview.person.country && (
                    <p className="text-xs text-slate-400">No public profile fields.</p>
                  )}
                </div>
              </div>

              <div>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Affiliations ({preview.affiliations.length})
                </h3>
                <div className="max-h-40 space-y-1 overflow-y-auto text-sm">
                  {preview.affiliations.map((a, i) => (
                    <label key={i} className="flex items-start gap-2">
                      {checkbox(affChecks[i] ?? false, (v) =>
                        setAffChecks((c) => c.map((x, j) => (j === i ? v : x))),
                      )}
                      <span>
                        {a.institution_name}
                        {a.role && <span className="text-slate-500"> — {a.role}</span>}
                        <span className="ml-1 text-xs text-slate-400">
                          {a.start_date ?? ''}
                          {(a.start_date || a.end_date) && '–'}
                          {a.end_date ?? (a.start_date ? 'now' : '')}
                        </span>
                      </span>
                    </label>
                  ))}
                  {preview.affiliations.length === 0 && (
                    <p className="text-xs text-slate-400">None public.</p>
                  )}
                </div>
              </div>

              <div>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Publications ({preview.publications.length})
                </h3>
                <div className="max-h-56 space-y-1 overflow-y-auto text-sm">
                  {preview.publications.map((p, i) => (
                    <label
                      key={i}
                      className={`flex items-start gap-2 ${p.already_imported ? 'opacity-50' : ''}`}
                    >
                      {checkbox(
                        (pubChecks[i] ?? false) && !p.already_imported,
                        (v) => setPubChecks((c) => c.map((x, j) => (j === i ? v : x))),
                        p.already_imported,
                      )}
                      <span>
                        {p.title}
                        <span className="ml-1 text-xs text-slate-400">
                          {p.year ?? ''}
                          {p.venue ? ` · ${p.venue}` : ''}
                          {p.doi ? ` · ${p.doi}` : ''}
                          {p.already_imported ? ' · already in library' : ''}
                        </span>
                      </span>
                    </label>
                  ))}
                  {preview.publications.length === 0 && (
                    <p className="text-xs text-slate-400">None public.</p>
                  )}
                </div>
              </div>

              <div className="flex justify-end gap-2 border-t border-slate-200 pt-3">
                <Btn variant="subtle" onClick={onClose}>
                  Cancel
                </Btn>
                <Btn
                  onClick={() => doImport.mutate(undefined)}
                  disabled={
                    doImport.isPending ||
                    existingPerson !== undefined ||
                    (personId === undefined && !name.trim())
                  }
                >
                  {doImport.isPending
                    ? 'Importing…'
                    : personId !== undefined
                      ? 'Import selected'
                      : 'Create person'}
                </Btn>
              </div>
              <ErrorText error={doImport.error} />
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
