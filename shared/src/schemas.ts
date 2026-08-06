import { z } from 'zod';

export const PUBLICATION_TYPES = [
  'article',
  'book',
  'chapter',
  'conference_paper',
  'thesis',
  'other',
] as const;

export type PublicationType = (typeof PUBLICATION_TYPES)[number];

/** Accepts a bare ORCID iD or a full https://orcid.org/… URL; returns the bare iD or null. */
export function normalizeOrcid(input: string): string | null {
  const m = input
    .trim()
    .toUpperCase()
    .match(/(\d{4}-\d{4}-\d{4}-\d{3}[\dX])$/);
  return m ? m[1] : null;
}

const optionalText = z.string().nullish();

export const personInput = z.object({
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

export const institutionInput = z.object({
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
  .object({
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
export const affiliationPatch = z.object({
  role: optionalText,
  start_date: optionalText,
  end_date: optionalText,
  note: optionalText,
});

export const publicationAuthorInput = z.object({
  name: z.string().min(1),
  person_id: z.number().int().positive().nullish(),
});

export const publicationInput = z.object({
  title: z.string().min(1),
  year: z.number().int().min(0).max(3000).nullish(),
  venue: optionalText,
  type: z.enum(PUBLICATION_TYPES).optional(),
  doi: optionalText,
  url: optionalText,
  abstract: optionalText,
  language: optionalText,
  note: optionalText,
  authors: z.array(publicationAuthorInput).min(1),
});
export const publicationPatch = publicationInput.partial();

export const relationInput = z
  .object({
    from_person_id: z.number().int().positive(),
    to_person_id: z.number().int().positive(),
    type: z.string().min(1),
    date: optionalText,
    note: optionalText,
  })
  .refine((v) => v.from_person_id !== v.to_person_id, {
    message: 'a relation must connect two different people',
  });
export const relationPatch = z.object({
  type: z.string().min(1).optional(),
  date: optionalText,
  note: optionalText,
});

export const tagsInput = z.object({
  tags: z.array(z.string().min(1)),
});

export const suggestionPromoteInput = z.object({
  name: z.string().min(1),
  person: personPatch.optional(),
});
export const suggestionLinkInput = z.object({
  name: z.string().min(1),
  person_id: z.number().int().positive(),
});
export const suggestionDismissInput = z.object({
  name: z.string().min(1),
});

export const orcidImportAffiliation = z.object({
  institution_name: z.string().min(1),
  ror_id: optionalText,
  role: optionalText,
  start_date: optionalText,
  end_date: optionalText,
});
export const orcidImportPublication = z.object({
  title: z.string().min(1),
  year: z.number().int().min(0).max(3000).nullish(),
  venue: optionalText,
  type: z.enum(PUBLICATION_TYPES).optional(),
  doi: optionalText,
  url: optionalText,
});
export const orcidImportInput = z.object({
  fields: personPatch.optional(),
  overwrite: z.boolean().optional(),
  affiliations: z.array(orcidImportAffiliation).optional(),
  publications: z.array(orcidImportPublication).optional(),
});
export const fromOrcidInput = orcidImportInput.extend({
  orcid: z.string().min(1),
  name: z.string().min(1),
});
