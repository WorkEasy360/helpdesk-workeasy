import { z } from 'zod';

export const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(128)
  .refine((v) => /[a-z]/.test(v), 'Password must contain a lowercase letter')
  .refine((v) => /[A-Z]/.test(v), 'Password must contain an uppercase letter')
  .refine((v) => /[0-9]/.test(v), 'Password must contain a digit');

export const loginSchema = z.object({
  email: z.string().email().toLowerCase().trim(),
  password: z.string().min(1).max(128),
  organizationSlug: z.string().trim().min(1).max(64).optional(),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const registerSchema = z.object({
  organizationName: z.string().trim().min(2).max(120),
  organizationSlug: z
    .string()
    .trim()
    .min(2)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, 'Use lowercase letters, digits and hyphens'),
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  email: z.string().email().toLowerCase().trim(),
  password: passwordSchema,
  timezone: z.string().trim().min(1).max(64).default('UTC'),
});
export type RegisterInput = z.infer<typeof registerSchema>;
/** Shape a form holds before defaults are applied — what react-hook-form binds to. */
export type RegisterFormValues = z.input<typeof registerSchema>;

export const forgotPasswordSchema = z.object({
  email: z.string().email().toLowerCase().trim(),
  organizationSlug: z.string().trim().min(1).max(64).optional(),
});
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z.object({
  token: z.string().min(10).max(200),
  password: passwordSchema,
});
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: passwordSchema,
});
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

export const verifyEmailSchema = z.object({ token: z.string().min(10).max(200) });
export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;

export interface AuthenticatedUser {
  id: string;
  organizationId: string;
  email: string;
  firstName: string;
  lastName: string;
  type: 'AGENT' | 'CUSTOMER';
  roles: string[];
  permissions: string[];
  /** Departments the user belongs to; narrows ticket visibility without `ticket.read.all`. */
  departmentIds: string[];
  /** Set for portal users: the contact record their tickets belong to. */
  contactId: string | null;
}

export interface LoginResponse {
  status: 'authenticated';
  accessToken: string;
  expiresIn: number;
  user: AuthenticatedUser;
}

/**
 * The same email address is a distinct account in each organization it belongs to, so a
 * password alone can't say which one the caller means. Returned instead of a session
 * when the credentials the caller gave match more than one — no token is issued and no
 * session cookie is set until the caller resubmits with `organizationSlug` set to one of
 * these. The org's own name is shown to pick from; its slug is what actually
 * disambiguates the next request.
 */
export interface OrganizationChoiceResponse {
  status: 'choose_organization';
  organizations: { slug: string; name: string }[];
}

export type LoginResult = LoginResponse | OrganizationChoiceResponse;

/** Which sign-in methods the login page should offer. Public: it says nothing about any account. */
export interface AuthMethods {
  /** Email + password sign-in (and registration, reset, invitations) is available. */
  password: boolean;
  /** "Continue with Workeasy360" is configured. */
  workeasy360: boolean;
  /** "Sign out of Easy Help Desk and Workeasy360" is offered. */
  workeasy360SignOut: boolean;
}

/**
 * The only values `sso_error` ever takes on the login page after a Workeasy360 sign-in that
 * did not complete. The frontend maps each to a message; details stay in the server log.
 */
export const WORKEASY360_SSO_ERROR_CODES = [
  'cancelled',
  'expired',
  'unavailable',
  'refused',
  'rate_limited',
  'not_entitled',
  'no_seat',
  'provider_membership_inactive',
  'organization_inactive',
  'access_policy',
  'email_missing',
  'email_unverified',
  'account_conflict',
  'account_disabled',
  'membership_inactive',
  'wrong_product',
  'wrong_organization',
] as const;
export type Workeasy360SsoErrorCode = (typeof WORKEASY360_SSO_ERROR_CODES)[number];

/** Why Easy Help Desk access ended or cannot be confirmed (the `/access-ended` screen). */
export const WORKEASY360_ACCESS_ERROR_CODES = [
  'WORKEASY360_ACCESS_ENDED',
  'WORKEASY360_READ_ONLY',
  'WORKEASY360_ACCESS_UNVERIFIED',
] as const;
export type Workeasy360AccessErrorCode = (typeof WORKEASY360_ACCESS_ERROR_CODES)[number];
