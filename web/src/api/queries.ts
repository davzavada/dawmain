import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AffiliationInput,
  FromOrcidInput,
  GraphData,
  InstitutionInput,
  InstitutionListItem,
  OrcidImportInput,
  OrcidPreview,
  Person,
  PersonDetail,
  PersonListItem,
  PersonPatch,
  PublicationInput,
  PublicationListItem,
  RelationInput,
  Suggestion,
  Tag,
} from '@crm/shared';
import { fetchJson } from './client';

export const api = {
  people: (search: string, tag: string) =>
    fetchJson<PersonListItem[]>(
      'GET',
      `api/people?search=${encodeURIComponent(search)}&tag=${encodeURIComponent(tag)}`,
    ),
  person: (id: number) => fetchJson<PersonDetail>('GET', `api/people/${id}`),
  createPerson: (input: PersonPatch & { name: string }) =>
    fetchJson<Person>('POST', 'api/people', input),
  patchPerson: (args: { id: number; patch: PersonPatch }) =>
    fetchJson<Person>('PATCH', `api/people/${args.id}`, args.patch),
  deletePerson: (id: number) => fetchJson<void>('DELETE', `api/people/${id}`),
  setTags: (args: { id: number; tags: string[] }) =>
    fetchJson<string[]>('PUT', `api/people/${args.id}/tags`, { tags: args.tags }),
  addAffiliation: (args: { personId: number; input: AffiliationInput }) =>
    fetchJson<unknown>('POST', `api/people/${args.personId}/affiliations`, args.input),
  deleteAffiliation: (id: number) => fetchJson<void>('DELETE', `api/affiliations/${id}`),
  institutions: (search: string) =>
    fetchJson<InstitutionListItem[]>('GET', `api/institutions?search=${encodeURIComponent(search)}`),
  createInstitution: (input: InstitutionInput) =>
    fetchJson<unknown>('POST', 'api/institutions', input),
  patchInstitution: (args: { id: number; patch: Partial<InstitutionInput> }) =>
    fetchJson<unknown>('PATCH', `api/institutions/${args.id}`, args.patch),
  deleteInstitution: (id: number) => fetchJson<void>('DELETE', `api/institutions/${id}`),
  publications: (search: string) =>
    fetchJson<PublicationListItem[]>(
      'GET',
      `api/publications?search=${encodeURIComponent(search)}`,
    ),
  createPublication: (input: PublicationInput) =>
    fetchJson<unknown>('POST', 'api/publications', input),
  patchPublication: (args: { id: number; patch: Partial<PublicationInput> }) =>
    fetchJson<unknown>('PATCH', `api/publications/${args.id}`, args.patch),
  deletePublication: (id: number) => fetchJson<void>('DELETE', `api/publications/${id}`),
  suggestions: () => fetchJson<Suggestion[]>('GET', 'api/suggestions'),
  promoteSuggestion: (args: { name: string; person?: PersonPatch }) =>
    fetchJson<{ person: Person; linked: number }>('POST', 'api/suggestions/promote', args),
  linkSuggestion: (args: { name: string; person_id: number }) =>
    fetchJson<{ linked: number }>('POST', 'api/suggestions/link', args),
  dismissSuggestion: (name: string) =>
    fetchJson<void>('POST', 'api/suggestions/dismiss', { name }),
  createRelation: (input: RelationInput) => fetchJson<unknown>('POST', 'api/relations', input),
  deleteRelation: (id: number) => fetchJson<void>('DELETE', `api/relations/${id}`),
  graph: () => fetchJson<GraphData>('GET', 'api/graph'),
  tags: () => fetchJson<Tag[]>('GET', 'api/tags'),
  orcidPreview: (orcid: string) =>
    fetchJson<OrcidPreview>('GET', `api/orcid/${encodeURIComponent(orcid)}/preview`),
  orcidImport: (args: { personId: number; input: OrcidImportInput }) =>
    fetchJson<{ detail: PersonDetail; imported: Record<string, number> }>(
      'POST',
      `api/people/${args.personId}/orcid-import`,
      args.input,
    ),
  fromOrcid: (input: FromOrcidInput) =>
    fetchJson<{ detail: PersonDetail; imported: Record<string, number> }>(
      'POST',
      'api/people/from-orcid',
      input,
    ),
};

export function usePeople(search: string, tag: string) {
  return useQuery({ queryKey: ['people', search, tag], queryFn: () => api.people(search, tag) });
}

export function usePerson(id: number | undefined) {
  return useQuery({
    queryKey: ['person', id],
    queryFn: () => api.person(id!),
    enabled: id !== undefined,
  });
}

export function useInstitutions(search: string) {
  return useQuery({ queryKey: ['institutions', search], queryFn: () => api.institutions(search) });
}

export function usePublications(search: string) {
  return useQuery({ queryKey: ['publications', search], queryFn: () => api.publications(search) });
}

export function useSuggestions() {
  return useQuery({ queryKey: ['suggestions'], queryFn: api.suggestions });
}

export function useGraph() {
  return useQuery({ queryKey: ['graph'], queryFn: api.graph });
}

export function useTags() {
  return useQuery({ queryKey: ['tags'], queryFn: api.tags });
}

/**
 * Mutation wrapper with the app-wide policy: any successful mutation
 * invalidates every query, so tables, detail panels and the graph always
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
      void queryClient.invalidateQueries();
      onSuccess?.(result);
    },
  });
}
