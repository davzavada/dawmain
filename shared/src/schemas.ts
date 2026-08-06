import { z } from 'zod';
import { RELATION_TYPES } from './relationTypes.js';
import { INTERACTION_KINDS } from './interactionKinds.js';

export const PUBLICATION_TYPES = [
  'article',
  'book',
  'chapter',
  'conference_paper',
  'thesis',
  'other',
] as const;

export type PublicationType = (typeof PUBLICATION_TYPES)[number];

export const READ_STATUSES = ['none', 'to_read', 'read'] as const;
export type ReadStatus = (typeof READ_STATUSES)[number];

const relationTypeEnum = z.enum(
  RELATION_TYPES.map((t) => t.value) as [string, ...string[]],
);
const interactionKindEnum = z.enum(
  INTERACTION_KINDS.map((k) => k.value) as [string, ...string[]],
);

/** Accepts a bare ORCID iD or a full https://orcid.org/… URL; returns the bare iD or null. */
export function normalizeOrcid(input: string): string | null {
  const m = input
    .trim()
    .toUpperCase()
    .match(/(\d{4}-\d{4}-\d{4}-\d{3}[\dX])$/);
  return m ? m[1] : null;
}

const optionalText = z.string().nullish();

export const personInput = z.strictObject({
  name: z.string().min(1),
  titles: optionalText,
  email: optionalText,
  website: optionalText,
  country: optionalText,
  note: optionalText,
  orcid: optionalText,
  openalex_id: optionalText,
  semantic_scholar_id: optionalText,
});
export const personPatch = personInput.partial();

export const institutionInput = z.strictObject({
  name: z.string().min(1),
  short_name: optionalText,
  city: optionalText,
  country: optionalText,
  url: optionalText,
  ror_id: optionalText,
  openalex_id: optionalText,
  note: optionalText,
});
export const institutionPatch = institutionInput.partial();

export const affiliationInput = z
  .strictObject({
    institution_id: z.number().int().positive().optional(),
    institution_name: z.string().min(1).optional(),
    role: optionalText,
    start_date: optionalText,
    end_date: optionalText,
    note: optionalText,
  })
  .refine((v) => v.institution_id !== undefined || v.institution_name !== undefined, {
    message: 'institution_id or institution_name is required',
  });
export const affiliationPatch = z.strictObject({
  role: optionalText,
  start_date: optionalText,
  end_date: optionalText,
  note: optionalText,
});

export const publicationAuthorInput = z.strictObject({
  name: z.string().min(1),
  person_id: z.number().int().positive().nullish(),
});

export const publicationInput = z.strictObject({
  title: z.string().min(1),
  year: z.number().int().min(0).max(3000).nullish(),
  venue: optionalText,
  type: z.enum(PUBLICATION_TYPES).optional(),
  doi: optionalText,
  url: optionalText,
  abstract: optionalText,
  language: optionalText,
  note: optionalText,
  starred: z.boolean().optional(),
  read_status: z.enum(READ_STATUSES).optional(),
  authors: z.array(publicationAuthorInput).min(1),
});
export const publicationPatch = publicationInput.partial();

export const relationInput = z
  .strictObject({
    from_person_id: z.number().int().positive(),
    to_person_id: z.number().int().positive(),
    type: relationTypeEnum,
    date: optionalText,
    note: optionalText,
  })
  .refine((v) => v.from_person_id !== v.to_person_id, {
    message: 'a relation must connect two different people',
  });
export const relationPatch = z.strictObject({
  type: relationTypeEnum.optional(),
  date: optionalText,
  note: optionalText,
});

export const interactionInput = z.strictObject({
  date: z.string().min(1),
  kind: interactionKindEnum.optional(),
  note: optionalText,
});
export const interactionPatch = interactionInput.partial();

export const mergeInput = z.strictObject({
  into_id: z.number().int().positive(),
});

export const tagsInput = z.strictObject({
  tags: z.array(z.string().min(1)),
});

export const suggestionPromoteInput = z.strictObject({
  name: z.string().min(1),
  person: personPatch.optional(),
});
export const suggestionLinkInput = z.strictObject({
  name: z.string().min(1),
  person_id: z.number().int().positive(),
});
export const suggestionDismissInput = z.strictObject({
  name: z.string().min(1),
});

export const orcidImportAffiliation = z.strictObject({
  institution_name: z.string().min(1),
  ror_id: optionalText,
  role: optionalText,
  start_date: optionalText,
  end_date: optionalText,
});
export const orcidImportPublication = z.strictObject({
  title: z.string().min(1),
  year: z.number().int().min(0).max(3000).nullish(),
  venue: optionalText,
  type: z.enum(PUBLICATION_TYPES).optional(),
  doi: optionalText,
  url: optionalText,
});
export const orcidImportInput = z.strictObject({
  fields: personPatch.optional(),
  overwrite: z.boolean().optional(),
  affiliations: z.array(orcidImportAffiliation).optional(),
  publications: z.array(orcidImportPublication).optional(),
});
export const fromOrcidInput = orcidImportInput.extend({
  orcid: z.string().min(1),
  name: z.string().min(1),
});
