import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type {
  AffiliationInput,
  AffiliationWithInstitution,
  DismissedSuggestion,
  FromOrcidInput,
  Institution,
  InstitutionDetail,
  InstitutionInput,
  InstitutionListItem,
  Interaction,
  InteractionInput,
  MergeCounts,
  OrcidImportInput,
  OrcidImportResult,
  OrcidPreview,
  PeopleSort,
  Person,
  PersonDetail,
  PersonListItem,
  PersonPatch,
  PublicationDetail,
  PublicationInput,
  PublicationListItem,
  ReadStatus,
  Relation,
  RelationInput,
  Suggestion,
  TagWithCount,
} from '@crm/shared';
import { fetchJson } from './client';

export interface PublicationFilters {
  search?: string;
  person_id?: number;
  starred?: boolean;
  read_status?: ReadStatus | '';
}

function publicationQueryString(filters: PublicationFilters): string {
  const params = new URLSearchParams();
  if (filters.search) params.set('search', filters.search);
  if (filters.person_id !== undefined) params.set('person_id', String(filters.person_id));
  if (filters.starred) params.set('starred', '1');
  if (filters.read_status) params.set('read_status', filters.read_status);
  return params.toString();
}

export const api = {
  people: (search: string, tag: string, sort: PeopleSort) =>
    fetchJson<PersonListItem[]>(
      'GET',
      `api/people?search=${encodeURIComponent(search)}&tag=${encodeURIComponent(tag)}&sort=${sort}`,
    ),
  person: (id: number) => fetchJson<PersonDetail>('GET', `api/people/${id}`),
  createPerson: (input: PersonPatch & { name: string }) =>
    fetchJson<Person>('POST', 'api/people', input),
  patchPerson: (args: { id: number; patch: PersonPatch }) =>
    fetchJson<Person>('PATCH', `api/people/${args.id}`, args.patch),
  deletePerson: (id: number) => fetchJson<void>('DELETE', `api/people/${id}`),
  mergePerson: (args: { id: number; into_id: number }) =>
    fetchJson<{ detail: PersonDetail; moved: MergeCounts }>('POST', `api/people/${args.id}/merge`, {
      into_id: args.into_id,
    }),
  setTags: (args: { id: number; tags: string[] }) =>
    fetchJson<string[]>('PUT', `api/people/${args.id}/tags`, { tags: args.tags }),
  addAffiliation: (args: { personId: number; input: AffiliationInput }) =>
    fetchJson<AffiliationWithInstitution>(
      'POST',
      `api/people/${args.personId}/affiliations`,
      args.input,
    ),
  patchAffiliation: (args: {
    id: number;
    patch: { role?: string | null; start_date?: string | null; end_date?: string | null; note?: string | null };
  }) => fetchJson<AffiliationWithInstitution>('PATCH', `api/affiliations/${args.id}`, args.patch),
  deleteAffiliation: (id: number) => fetchJson<void>('DELETE', `api/affiliations/${id}`),
  addInteraction: (args: { personId: number; input: InteractionInput }) =>
    fetchJson<Interaction>('POST', `api/people/${args.personId}/interactions`, args.input),
  patchInteraction: (args: { id: number; patch: Partial<InteractionInput> }) =>
    fetchJson<Interaction>('PATCH', `api/interactions/${args.id}`, args.patch),
  deleteInteraction: (id: number) => fetchJson<void>('DELETE', `api/interactions/${id}`),
  institutions: (search: string) =>
    fetchJson<InstitutionListItem[]>(
      'GET',
      `api/institutions?search=${encodeURIComponent(search)}`,
    ),
  institution: (id: number) => fetchJson<InstitutionDetail>('GET', `api/institutions/${id}`),
  createInstitution: (input: InstitutionInput) =>
    fetchJson<Institution>('POST', 'api/institutions', input),
  patchInstitution: (args: { id: number; patch: Partial<InstitutionInput> }) =>
    fetchJson<Institution>('PATCH', `api/institutions/${args.id}`, args.patch),
  deleteInstitution: (id: number) => fetchJson<void>('DELETE', `api/institutions/${id}`),
  publications: (filters: PublicationFilters) =>
    fetchJson<PublicationListItem[]>('GET', `api/publications?${publicationQueryString(filters)}`),
  publication: (id: number) => fetchJson<PublicationDetail>('GET', `api/publications/${id}`),
  createPublication: (input: PublicationInput) =>
    fetchJson<PublicationDetail>('POST', 'api/publications', input),
  patchPublication: (args: { id: number; patch: Partial<PublicationInput> }) =>
    fetchJson<PublicationDetail>('PATCH', `api/publications/${args.id}`, args.patch),
  deletePublication: (id: number) => fetchJson<void>('DELETE', `api/publications/${id}`),
  suggestions: () => fetchJson<Suggestion[]>('GET', 'api/suggestions'),
  promoteSuggestion: (args: { name: string; person?: PersonPatch }) =>
    fetchJson<{ person: Person; linked: number }>('POST', 'api/suggestions/promote', args),
  linkSuggestion: (args: { name: string; person_id: number }) =>
    fetchJson<{ linked: number }>('POST', 'api/suggestions/link', args),
  dismissSuggestion: (name: string) =>
    fetchJson<void>('POST', 'api/suggestions/dismiss', { name }),
  dismissedSuggestions: () =>
    fetchJson<DismissedSuggestion[]>('GET', 'api/suggestions/dismissed'),
  undismissSuggestion: (name: string) =>
    fetchJson<void>('DELETE', `api/suggestions/dismissed/${encodeURIComponent(name)}`),
  createRelation: (input: RelationInput) => fetchJson<Relation>('POST', 'api/relations', input),
  patchRelation: (args: {
    id: number;
    patch: { type?: string; date?: string | null; note?: string | null };
  }) => fetchJson<Relation>('PATCH', `api/relations/${args.id}`, args.patch),
  deleteRelation: (id: number) => fetchJson<void>('DELETE', `api/relations/${id}`),
  tags: () => fetchJson<TagWithCount[]>('GET', 'api/tags'),
  orcidPreview: (orcid: string) =>
    fetchJson<OrcidPreview>('GET', `api/orcid/${encodeURIComponent(orcid)}/preview`),
  orcidImport: (args: { personId: number; input: OrcidImportInput }) =>
    fetchJson<OrcidImportResult>('POST', `api/people/${args.personId}/orcid-import`, args.input),
  fromOrcid: (input: FromOrcidInput) =>
    fetchJson<OrcidImportResult>('POST', 'api/people/from-orcid', input),
};

export function usePeople(search: string, tag: string, sort: PeopleSort = 'name') {
  return useQuery({
    queryKey: ['people', search, tag, sort],
    queryFn: () => api.people(search, tag, sort),
    placeholderData: keepPreviousData,
  });
}

export function usePerson(id: number | undefined) {
  return useQuery({
    queryKey: ['person', id],
    queryFn: () => api.person(id!),
    enabled: id !== undefined,
  });
}

export function useInstitutions(search: string) {
  return useQuery({
    queryKey: ['institutions', search],
    queryFn: () => api.institutions(search),
    placeholderData: keepPreviousData,
  });
}

export function useInstitutionDetail(id: number | undefined) {
  return useQuery({
    queryKey: ['institution', id],
    queryFn: () => api.institution(id!),
    enabled: id !== undefined,
  });
}

export function usePublications(filters: PublicationFilters) {
  return useQuery({
    queryKey: ['publications', filters],
    queryFn: () => api.publications(filters),
    placeholderData: keepPreviousData,
  });
}

export function usePublicationDetail(id: number | undefined) {
  return useQuery({
    queryKey: ['publication', id],
    queryFn: () => api.publication(id!),
    enabled: id !== undefined,
  });
}

export function useSuggestions() {
  return useQuery({ queryKey: ['suggestions'], queryFn: api.suggestions });
}

export function useDismissedSuggestions() {
  return useQuery({ queryKey: ['dismissed'], queryFn: api.dismissedSuggestions });
}

export function useTags() {
  return useQuery({ queryKey: ['tags'], queryFn: api.tags });
}

/**
 * Mutation wrapper with the app-wide policy: any successful mutation
 * invalidates every query, so tables, detail panels and counts always
 * refresh. Blunt and correct at this data size.
 */
export function useAppMutation<TArgs, TOut>(
  fn: (args: TArgs) => Promise<TOut>,
  onSuccess?: (result: TOut) => void,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (result) => {
      onSuccess?.(result);
      void queryClient.invalidateQueries();
    },
  });
}
