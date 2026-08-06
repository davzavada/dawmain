import type { z } from 'zod';
import type {
  personInput,
  personPatch,
  institutionInput,
  publicationInput,
  relationInput,
  affiliationInput,
  interactionInput,
  orcidImportInput,
  fromOrcidInput,
  PublicationType,
  ReadStatus,
} from './schemas.js';

export type PersonInput = z.infer<typeof personInput>;
export type PersonPatch = z.infer<typeof personPatch>;
export type InstitutionInput = z.infer<typeof institutionInput>;
export type PublicationInput = z.infer<typeof publicationInput>;
export type RelationInput = z.infer<typeof relationInput>;
export type AffiliationInput = z.infer<typeof affiliationInput>;
export type InteractionInput = z.infer<typeof interactionInput>;
export type OrcidImportInput = z.infer<typeof orcidImportInput>;
export type FromOrcidInput = z.infer<typeof fromOrcidInput>;

export interface Person {
  id: number;
  name: string;
  titles: string | null;
  email: string | null;
  website: string | null;
  country: string | null;
  note: string | null;
  orcid: string | null;
  openalex_id: string | null;
  semantic_scholar_id: string | null;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface Institution {
  id: number;
  name: string;
  short_name: string | null;
  city: string | null;
  country: string | null;
  url: string | null;
  ror_id: string | null;
  openalex_id: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface InstitutionListItem extends Institution {
  person_count: number;
}

export interface InstitutionPerson {
  id: number;
  name: string;
  titles: string | null;
  role: string | null;
  start_date: string | null;
  end_date: string | null;
  current: boolean;
}

export interface InstitutionDetail {
  institution: Institution;
  people: InstitutionPerson[];
}

export interface AffiliationWithInstitution {
  id: number;
  role: string | null;
  start_date: string | null;
  end_date: string | null;
  note: string | null;
  institution: { id: number; name: string; short_name: string | null };
}

export interface Interaction {
  id: number;
  person_id: number;
  date: string;
  kind: string;
  note: string | null;
  created_at: string;
}

export interface PersonListItem {
  id: number;
  name: string;
  titles: string | null;
  country: string | null;
  orcid: string | null;
  tags: string[];
  affiliations: string;
  publication_count: number;
  relation_count: number;
  last_contact: string | null;
}

export type PeopleSort = 'name' | 'recent' | 'stale';

export interface PublicationAuthor {
  position: number;
  name: string;
  person_id: number | null;
}

export interface PublicationListItem {
  id: number;
  title: string;
  year: number | null;
  venue: string | null;
  type: string;
  doi: string | null;
  url: string | null;
  note: string | null;
  starred: boolean;
  read_status: ReadStatus;
  authors: PublicationAuthor[];
}

export interface PublicationDetail extends PublicationListItem {
  abstract: string | null;
  language: string | null;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface PersonPublication {
  id: number;
  title: string;
  year: number | null;
  venue: string | null;
  type: string;
  doi: string | null;
  url: string | null;
  starred: boolean;
  position: number;
  coauthors: { name: string; person_id: number | null }[];
}

export interface Relation {
  id: number;
  from_person_id: number;
  to_person_id: number;
  type: string;
  date: string | null;
  note: string | null;
  created_at: string;
}

export interface PersonRelation {
  id: number;
  type: string;
  direction: 'out' | 'in';
  other: { id: number; name: string };
  date: string | null;
  note: string | null;
}

export interface PersonCoauthor {
  person_id: number;
  name: string;
  shared_count: number;
}

export interface PersonDetail {
  person: Person;
  tags: string[];
  affiliations: AffiliationWithInstitution[];
  interactions: Interaction[];
  publications: PersonPublication[];
  relations: PersonRelation[];
  coauthors: PersonCoauthor[];
}

export interface Suggestion {
  name: string;
  count: number;
  publications: { id: number; title: string }[];
}

export interface DismissedSuggestion {
  author_name: string;
  dismissed_at: string;
}

export interface Tag {
  id: number;
  name: string;
  color: string | null;
}

export interface TagWithCount extends Tag {
  person_count: number;
}

export interface MergeCounts {
  publications: number;
  affiliations: number;
  relations: number;
  interactions: number;
  tags: number;
  fields: number;
}

export interface GraphNode {
  id: number;
  name: string;
  tags: string[];
  degree: number;
}

export type GraphEdge =
  | {
      id: string;
      kind: 'relation';
      source: number;
      target: number;
      type: string;
      directed: boolean;
      date: string | null;
      note: string | null;
    }
  | {
      id: string;
      kind: 'coauthor';
      source: number;
      target: number;
      weight: number;
    };

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface OrcidPreviewAffiliation {
  institution_name: string;
  ror_id: string | null;
  role: string | null;
  start_date: string | null;
  end_date: string | null;
}

export interface OrcidPreviewPublication {
  title: string;
  year: number | null;
  venue: string | null;
  type: PublicationType;
  doi: string | null;
  url: string | null;
  already_imported: boolean;
}

export interface OrcidPreview {
  orcid: string;
  person: {
    name: string | null;
    website: string | null;
    country: string | null;
    keywords: string[];
  };
  affiliations: OrcidPreviewAffiliation[];
  publications: OrcidPreviewPublication[];
}

export interface OrcidImportCounts {
  fields: number;
  affiliations: number;
  publications: number;
}

export interface OrcidImportResult {
  detail: PersonDetail;
  imported: OrcidImportCounts;
}
