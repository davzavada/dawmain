import {
  normalizeOrcid,
  type OrcidPreview,
  type OrcidPreviewAffiliation,
  type OrcidPreviewPublication,
  type PublicationType,
} from '@crm/shared';
import { db } from '../db.js';
import { BadRequestError, NotFoundError, UpstreamError } from '../errors.js';
import { normalizeDoi } from '../helpers.js';

const ORCID_API = 'https://pub.orcid.org/v3.0';

/* The ORCID v3.0 record JSON is deeply nested and every branch is optional,
 * so this module reads it with loose types and defensive access. */
type Json = Record<string, any>;

const WORK_TYPE_MAP: Record<string, PublicationType> = {
  'journal-article': 'article',
  'journal-issue': 'article',
  'magazine-article': 'article',
  'newsletter-article': 'article',
  'newspaper-article': 'article',
  'online-resource': 'other',
  preprint: 'article',
  'working-paper': 'article',
  book: 'book',
  'edited-book': 'book',
  'book-review': 'article',
  'book-chapter': 'chapter',
  'conference-paper': 'conference_paper',
  'conference-abstract': 'conference_paper',
  'conference-poster': 'conference_paper',
  'dissertation-thesis': 'thesis',
  dissertation: 'thesis',
  'supervised-student-publication': 'thesis',
};

function dateString(date: Json | null | undefined): string | null {
  const year = date?.year?.value;
  if (!year) return null;
  const month = date?.month?.value;
  const day = date?.day?.value;
  let result = String(year);
  if (month) {
    result += `-${String(month).padStart(2, '0')}`;
    if (day) result += `-${String(day).padStart(2, '0')}`;
  }
  return result;
}

export function requireOrcid(raw: string): string {
  const orcid = normalizeOrcid(raw);
  if (!orcid) throw new BadRequestError(`Invalid ORCID iD: ${raw}`);
  return orcid;
}

export async function fetchOrcidRecord(orcid: string): Promise<Json> {
  let res: Response;
  try {
    res = await fetch(`${ORCID_API}/${orcid}/record`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new UpstreamError(`Could not reach ORCID: ${reason}`);
  }
  if (res.status === 404) throw new NotFoundError(`ORCID iD ${orcid} not found`);
  if (!res.ok) throw new UpstreamError(`ORCID returned HTTP ${res.status}`);
  return (await res.json()) as Json;
}

function mapAffiliationGroup(groups: Json[] | undefined, summaryKey: string): OrcidPreviewAffiliation[] {
  const result: OrcidPreviewAffiliation[] = [];
  for (const group of groups ?? []) {
    for (const wrapper of group?.summaries ?? []) {
      const summary = wrapper?.[summaryKey];
      const organization = summary?.organization;
      if (!organization?.name) continue;
      const disambiguated = organization?.['disambiguated-organization'];
      const rorId =
        disambiguated?.['disambiguation-source'] === 'ROR'
          ? (disambiguated?.['disambiguated-organization-identifier'] ?? null)
          : null;
      result.push({
        institution_name: organization.name,
        ror_id: rorId,
        role: summary?.['role-title'] ?? null,
        start_date: dateString(summary?.['start-date']),
        end_date: dateString(summary?.['end-date']),
      });
    }
  }
  return result;
}

function mapWorks(record: Json): Omit<OrcidPreviewPublication, 'already_imported'>[] {
  const result: Omit<OrcidPreviewPublication, 'already_imported'>[] = [];
  for (const group of record?.['activities-summary']?.works?.group ?? []) {
    const summary = group?.['work-summary']?.[0];
    const title = summary?.title?.title?.value;
    if (!title) continue;
    const yearRaw = summary?.['publication-date']?.year?.value;
    const year = yearRaw ? Number(yearRaw) : null;
    let doi: string | null = null;
    for (const ext of summary?.['external-ids']?.['external-id'] ?? []) {
      if (ext?.['external-id-type'] === 'doi' && ext?.['external-id-value']) {
        doi = String(ext['external-id-value']);
        break;
      }
    }
    result.push({
      title,
      year: Number.isFinite(year) ? year : null,
      venue: summary?.['journal-title']?.value ?? null,
      type: WORK_TYPE_MAP[summary?.type ?? ''] ?? 'other',
      doi,
      url: summary?.url?.value ?? null,
    });
  }
  return result;
}

/**
 * Fetches a public ORCID record and maps it to CRM shapes. Publications are
 * flagged already_imported when a stored publication matches by DOI (or, for
 * DOI-less works, by title).
 */
export async function orcidPreview(orcid: string): Promise<OrcidPreview> {
  const record = await fetchOrcidRecord(orcid);

  const nameNode = record?.person?.name;
  const given = nameNode?.['given-names']?.value ?? '';
  const family = nameNode?.['family-name']?.value ?? '';
  const name = `${given} ${family}`.trim() || null;

  const website =
    record?.person?.['researcher-urls']?.['researcher-url']?.[0]?.url?.value ?? null;
  const country = record?.person?.addresses?.address?.[0]?.country?.value ?? null;
  const keywords = (record?.person?.keywords?.keyword ?? [])
    .map((k: Json) => k?.content)
    .filter((k: unknown): k is string => typeof k === 'string' && k.length > 0);

  const affiliations = [
    ...mapAffiliationGroup(
      record?.['activities-summary']?.employments?.['affiliation-group'],
      'employment-summary',
    ),
    ...mapAffiliationGroup(
      record?.['activities-summary']?.educations?.['affiliation-group'],
      'education-summary',
    ),
  ];

  const existing = db
    .prepare('SELECT id, title, doi FROM publications')
    .all() as unknown as { id: number; title: string; doi: string | null }[];
  const existingDois = new Set(
    existing.filter((p) => p.doi).map((p) => normalizeDoi(p.doi!)),
  );
  const existingTitles = new Set(existing.map((p) => p.title.toLowerCase()));

  const publications: OrcidPreviewPublication[] = mapWorks(record).map((work) => ({
    ...work,
    already_imported: work.doi
      ? existingDois.has(normalizeDoi(work.doi))
      : existingTitles.has(work.title.toLowerCase()),
  }));

  return {
    orcid,
    person: { name, website, country, keywords },
    affiliations,
    publications,
  };
}
