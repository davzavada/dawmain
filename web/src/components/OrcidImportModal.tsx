import { useEffect, useState } from 'react';
import type { OrcidPreview } from '@crm/shared';
import { api, useAppMutation } from '../api/queries';
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

  const loadPreview = async (id: string) => {
    setFetching(true);
    setFetchError(null);
    try {
      const data = await api.orcidPreview(id.trim());
      setPreview(data);
      setName(data.person.name ?? '');
      setAffChecks(data.affiliations.map(() => true));
      setPubChecks(data.publications.map((p) => !p.already_imported));
    } catch (err) {
      setFetchError(err);
    } finally {
      setFetching(false);
    }
  };

  useEffect(() => {
    if (presetOrcid) void loadPreview(presetOrcid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetOrcid]);

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
      onClose();
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
      {!preview && (
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
            {fetching ? 'Fetching…' : 'Fetch'}
          </Btn>
        </form>
      )}
      {fetching && preview === null && presetOrcid && (
        <p className="text-sm text-slate-400">Fetching ORCID record…</p>
      )}
      <ErrorText error={fetchError} />

      {preview && (
        <div className="space-y-4">
          <div className="rounded-md bg-slate-50 p-3">
            <p className="text-sm">
              <span className="font-semibold">{preview.person.name ?? '(name not public)'}</span>{' '}
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
                  {checkbox(fieldChecks.website, (v) => setFieldChecks((f) => ({ ...f, website: v })))}
                  <span>
                    Website: <span className="text-slate-600">{preview.person.website}</span>
                  </span>
                </label>
              )}
              {preview.person.country && (
                <label className="flex items-start gap-2">
                  {checkbox(fieldChecks.country, (v) => setFieldChecks((f) => ({ ...f, country: v })))}
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
              disabled={doImport.isPending || (personId === undefined && !name.trim())}
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
    </Modal>
  );
}
