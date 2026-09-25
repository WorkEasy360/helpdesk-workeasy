import { z } from 'zod';
import { paginationQuerySchema } from './pagination';
import { optionalField, queryBoolean, patchSchema } from './field';

export const CONTACT_STATUSES = ['ACTIVE', 'INACTIVE', 'BLOCKED'] as const;
export type ContactStatus = (typeof CONTACT_STATUSES)[number];

export const createContactSchema = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: optionalField(z.string().trim().max(80)),
  email: optionalField(z.string().email().toLowerCase().trim()),
  phone: optionalField(z.string().trim().max(40)),
  mobile: optionalField(z.string().trim().max(40)),
  jobTitle: optionalField(z.string().trim().max(120)),
  accountId: optionalField(z.string().min(1)),
  status: z.enum(CONTACT_STATUSES).default('ACTIVE'),
  isVip: z.boolean().default(false),
  customFields: z.record(z.string(), z.unknown()).nullable().optional(),
});
export type CreateContactInput = z.infer<typeof createContactSchema>;
export type ContactFormValues = z.input<typeof createContactSchema>;

export const updateContactSchema = patchSchema(createContactSchema);
export type UpdateContactInput = z.infer<typeof updateContactSchema>;

export const listContactsQuerySchema = paginationQuerySchema.extend({
  accountId: z.string().min(1).optional(),
  status: z.enum(CONTACT_STATUSES).optional(),
  isVip: queryBoolean.optional(),
});
export type ListContactsQuery = z.infer<typeof listContactsQuerySchema>;
