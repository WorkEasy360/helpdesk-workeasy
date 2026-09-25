import { z } from 'zod';
import { paginationQuerySchema } from './pagination';
import { passwordSchema } from './auth';
import { optionalField, queryBoolean, patchSchema } from './field';

export const createUserSchema = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  email: z.string().email().toLowerCase().trim(),
  phone: optionalField(z.string().trim().max(40)),
  password: passwordSchema.optional(),
  roleIds: z.array(z.string().min(1)).min(1),
  departmentIds: z.array(z.string().min(1)).default([]),
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

/** Invitations never carry a password: the invited agent sets their own. */
export const inviteUserSchema = createUserSchema.omit({ password: true });
export type InviteUserInput = z.infer<typeof inviteUserSchema>;
export type InviteUserFormValues = z.input<typeof inviteUserSchema>;

export const updateUserSchema = z.object({
  firstName: z.string().trim().min(1).max(80).optional(),
  lastName: z.string().trim().min(1).max(80).optional(),
  phone: optionalField(z.string().trim().max(40)),
  avatarUrl: optionalField(z.string().url().max(500)),
});
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

export const setUserRolesSchema = z.object({ roleIds: z.array(z.string().min(1)).min(1) });
export const setUserDepartmentsSchema = z.object({ departmentIds: z.array(z.string().min(1)) });

export const listUsersQuerySchema = paginationQuerySchema.extend({
  isActive: queryBoolean.optional(),
  departmentId: z.string().min(1).optional(),
  roleId: z.string().min(1).optional(),
});
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;

export const createRoleSchema = z.object({
  name: z.string().trim().min(2).max(60),
  description: optionalField(z.string().trim().max(255)),
  permissionKeys: z.array(z.string().min(1)).default([]),
});
export type CreateRoleInput = z.infer<typeof createRoleSchema>;
export type RoleFormValues = z.input<typeof createRoleSchema>;

export const updateRoleSchema = patchSchema(createRoleSchema);
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;
