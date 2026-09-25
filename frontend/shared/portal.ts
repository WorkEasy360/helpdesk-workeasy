import { z } from 'zod';
import { paginationQuerySchema } from './pagination';
import { optionalField, queryBoolean, patchSchema } from './field';
import { passwordSchema } from './auth';
import { slugSchema } from './slug';

// ---------------------------------------------------------------------------
// Help center settings
// ---------------------------------------------------------------------------

const hexColor = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour such as #2563eb');

export const helpCenterSettingsSchema = z.object({
  slug: slugSchema.optional(),
  name: z.string().trim().min(2).max(120).optional(),
  tagline: optionalField(z.string().trim().max(200)),
  welcomeMessage: optionalField(z.string().trim().max(500)),
  logoUrl: optionalField(z.string().url().max(500)),
  primaryColor: hexColor.optional(),
  supportEmail: optionalField(z.string().email().toLowerCase().trim()),
  footerText: optionalField(z.string().trim().max(500)),
  isPublished: z.boolean().optional(),
  allowPublicBrowsing: z.boolean().optional(),
  allowSelfRegistration: z.boolean().optional(),
  allowTicketSubmission: z.boolean().optional(),
  kbEnabled: z.boolean().optional(),
  communityEnabled: z.boolean().optional(),
  moderateCommunity: z.boolean().optional(),
});
export type HelpCenterSettingsInput = z.infer<typeof helpCenterSettingsSchema>;
export type HelpCenterSettingsFormValues = z.input<typeof helpCenterSettingsSchema>;

// ---------------------------------------------------------------------------
// Web forms
// ---------------------------------------------------------------------------

export const WEB_FORM_FIELD_TYPES = [
  'TEXT',
  'TEXTAREA',
  'EMAIL',
  'PHONE',
  'NUMBER',
  'SELECT',
  'CHECKBOX',
  'DATE',
] as const;
export type WebFormFieldType = (typeof WEB_FORM_FIELD_TYPES)[number];

/**
 * Where a submitted value goes. Mapped fields fill the ticket itself; everything
 * else is stored on the ticket's `customFields` under the field key.
 */
export const WEB_FORM_FIELD_TARGETS = [
  'subject',
  'description',
  'name',
  'email',
  'phone',
  'custom',
] as const;
export type WebFormFieldTarget = (typeof WEB_FORM_FIELD_TARGETS)[number];

export const webFormFieldSchema = z.object({
  key: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[a-z][a-z0-9_]*$/, 'Use lowercase letters, digits and underscores'),
  label: z.string().trim().min(1).max(120),
  type: z.enum(WEB_FORM_FIELD_TYPES),
  required: z.boolean().default(false),
  placeholder: optionalField(z.string().trim().max(120)),
  helpText: optionalField(z.string().trim().max(200)),
  options: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
  mapsTo: z.enum(WEB_FORM_FIELD_TARGETS).default('custom'),
});
export type WebFormField = z.infer<typeof webFormFieldSchema>;
export type WebFormFieldValues = z.input<typeof webFormFieldSchema>;

export const webFormFieldListSchema = z
  .array(webFormFieldSchema)
  .min(1, 'A form needs at least one field')
  .max(30)
  .superRefine((fields, ctx) => {
    const keys = new Set<string>();
    for (const field of fields) {
      if (keys.has(field.key)) {
        ctx.addIssue({ code: 'custom', message: `Duplicate field key "${field.key}"` });
      }
      keys.add(field.key);
      if (field.type === 'SELECT' && field.options.length === 0) {
        ctx.addIssue({ code: 'custom', message: `"${field.label}" needs at least one option` });
      }
    }
    if (!fields.some((field) => field.mapsTo === 'description')) {
      ctx.addIssue({ code: 'custom', message: 'One field must map to the request description' });
    }
  });

export const webFormSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: slugSchema.optional(),
  description: optionalField(z.string().trim().max(500)),
  departmentId: optionalField(z.string().min(1)),
  categoryId: optionalField(z.string().min(1)),
  priorityId: optionalField(z.string().min(1)),
  fields: webFormFieldListSchema,
  submitLabel: z.string().trim().min(1).max(60).default('Submit request'),
  successMessage: z.string().trim().min(1).max(300).default('Thanks — we have received your request.'),
  requireLogin: z.boolean().default(false),
  isActive: z.boolean().default(true),
});
export type WebFormInput = z.infer<typeof webFormSchema>;
export type WebFormFormValues = z.input<typeof webFormSchema>;

export const updateWebFormSchema = patchSchema(webFormSchema);
export type UpdateWebFormInput = z.infer<typeof updateWebFormSchema>;

const submissionValue = z.union([
  z.string().max(10_000),
  z.number(),
  z.boolean(),
  z.null(),
]);

export const webFormSubmissionSchema = z.object({
  values: z.record(z.string().max(40), submissionValue),
  /**
   * Honeypot. Real people never see this input, so anything in it is a bot. The value
   * is accepted and the submission silently dropped, which tells a bot nothing — no
   * third-party captcha required.
   */
  website: z.string().max(200).optional(),
});
export type WebFormSubmissionInput = z.infer<typeof webFormSubmissionSchema>;

// ---------------------------------------------------------------------------
// Portal accounts and tickets
// ---------------------------------------------------------------------------

export const portalRegisterSchema = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: optionalField(z.string().trim().max(80)),
  email: z.string().email().toLowerCase().trim(),
  password: passwordSchema,
});
export type PortalRegisterInput = z.infer<typeof portalRegisterSchema>;
export type PortalRegisterFormValues = z.input<typeof portalRegisterSchema>;

export const portalLoginSchema = z.object({
  email: z.string().email().toLowerCase().trim(),
  password: z.string().min(1).max(128),
});
export type PortalLoginInput = z.infer<typeof portalLoginSchema>;

export const portalForgotPasswordSchema = z.object({
  email: z.string().email().toLowerCase().trim(),
});
export type PortalForgotPasswordInput = z.infer<typeof portalForgotPasswordSchema>;

export const portalCreateTicketSchema = z.object({
  subject: z.string().trim().min(3).max(200),
  description: z.string().trim().min(1).max(20_000),
  departmentId: optionalField(z.string().min(1)),
  categoryId: optionalField(z.string().min(1)),
  priorityId: optionalField(z.string().min(1)),
});
export type PortalCreateTicketInput = z.infer<typeof portalCreateTicketSchema>;
export type PortalCreateTicketFormValues = z.input<typeof portalCreateTicketSchema>;

export const portalReplySchema = z.object({
  bodyText: z.string().trim().min(1).max(20_000),
  attachmentIds: z.array(z.string().min(1)).max(10).default([]),
});
export type PortalReplyInput = z.infer<typeof portalReplySchema>;

export const portalListTicketsQuerySchema = paginationQuerySchema.extend({
  open: queryBoolean.optional(),
});
export type PortalListTicketsQuery = z.infer<typeof portalListTicketsQuerySchema>;
