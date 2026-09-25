import { z } from 'zod';
import { paginationQuerySchema } from './pagination';
import { optionalField, patchSchema } from './field';

export const createDepartmentSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: optionalField(z.string().trim().max(500)),
  email: optionalField(z.string().email().toLowerCase().trim()),
  parentId: optionalField(z.string().min(1)),
  isDefault: z.boolean().default(false),
});
export type CreateDepartmentInput = z.infer<typeof createDepartmentSchema>;
export type DepartmentFormValues = z.input<typeof createDepartmentSchema>;
export const updateDepartmentSchema = patchSchema(createDepartmentSchema);
export type UpdateDepartmentInput = z.infer<typeof updateDepartmentSchema>;

export const createTeamSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: optionalField(z.string().trim().max(500)),
  departmentId: optionalField(z.string().min(1)),
  memberIds: z.array(z.string().min(1)).default([]),
});
export type CreateTeamInput = z.infer<typeof createTeamSchema>;
export type TeamFormValues = z.input<typeof createTeamSchema>;
export const updateTeamSchema = patchSchema(createTeamSchema);
export type UpdateTeamInput = z.infer<typeof updateTeamSchema>;

export const listDepartmentsQuerySchema = paginationQuerySchema;
