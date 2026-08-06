import type { z } from 'zod';
import type {
  personInput,
  personPatch,
  institutionInput,
  publicationInput,
  relationInput,
  affiliationInput,
  orcidImportInput,
  fromOrcidInput,
} from './schemas.js';

export type PersonInput = z.infer<typeof personInput>;
export type PersonPatch = z.infer<typeof personPatch>;
export type InstitutionInput = z.infer<typeof institutionInput>;
export type PublicationInput = z.infer<typeof publicationInput>;
export type RelationInput = z.infer<typeof relationInput>;
export type AffiliationInput = z.infer<typeof affiliationInput>;
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

export interface AffiliationWithInstitution {
  id: number;
  role: string | null;
  start_date: string | null;
  end_date: string | null;
  note: string | null;
  institution: { id: number; name: string; short_name: string | null };
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
}

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
  authors: PublicationAuthor[];
}

export interface PersonPublication {
  id: number;
  title: string;
  year: number | null;
  venue: string | null;
  type: string;
  doi: string | null;
  url: string | null;
  position: number;
  coauthors: { name: string; person_id: number | null }[];
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
  publications: PersonPublication[];
  relations: PersonRelation[];
  coauthors: PersonCoauthor[];
}

export interface Suggestion {
  name: string;
  count: number;
  publications: { id: number; title: string }[];
}

export interface Tag {
  id: number;
  name: string;
  color: string | null;
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
  type: string;
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
