import { z } from 'zod';
import { paginationQuerySchema } from './pagination';
import { optionalField, patchSchema } from './field';

export const createAccountSchema = z.object({
  name: z.string().trim().min(1).max(150),
  website: optionalField(z.string().url().max(255)),
  industry: optionalField(z.string().trim().max(120)),
  phone: optionalField(z.string().trim().max(40)),
  email: optionalField(z.string().email().toLowerCase().trim()),
  addressLine1: optionalField(z.string().trim().max(200)),
  addressLine2: optionalField(z.string().trim().max(200)),
  city: optionalField(z.string().trim().max(120)),
  state: optionalField(z.string().trim().max(120)),
  postalCode: optionalField(z.string().trim().max(30)),
  country: optionalField(z.string().trim().max(120)),
  description: optionalField(z.string().trim().max(2000)),
  customFields: z.record(z.string(), z.unknown()).nullable().optional(),
});
export type CreateAccountInput = z.infer<typeof createAccountSchema>;
export type AccountFormValues = z.input<typeof createAccountSchema>;

export const updateAccountSchema = patchSchema(createAccountSchema);
export type UpdateAccountInput = z.infer<typeof updateAccountSchema>;

export const listAccountsQuerySchema = paginationQuerySchema.extend({
  industry: z.string().trim().max(120).optional(),
});
export type ListAccountsQuery = z.infer<typeof listAccountsQuerySchema>;
