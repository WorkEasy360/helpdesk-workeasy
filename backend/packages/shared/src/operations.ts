import { z } from 'zod';
import { paginationQuerySchema } from './pagination';
import { optionalField, queryBoolean, patchSchema } from './field';
import { actionListSchema, conditionTreeSchema } from './rules';

// ---------------------------------------------------------------------------
// Activities
// ---------------------------------------------------------------------------

export const ACTIVITY_TYPES = ['TASK', 'CALL', 'EVENT'] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];
export const ACTIVITY_STATUSES = ['OPEN', 'COMPLETED', 'CANCELLED'] as const;
export type ActivityStatus = (typeof ACTIVITY_STATUSES)[number];
export const CALL_DIRECTIONS = ['INBOUND', 'OUTBOUND'] as const;

export const createActivitySchema = z.object({
  type: z.enum(ACTIVITY_TYPES),
  subject: z.string().trim().min(1).max(200),
  description: optionalField(z.string().trim().max(5000)),
  dueAt: optionalField(z.coerce.date()),
  startAt: optionalField(z.coerce.date()),
  endAt: optionalField(z.coerce.date()),
  callDirection: optionalField(z.enum(CALL_DIRECTIONS)),
  callDurationSeconds: optionalField(z.coerce.number().int().min(0).max(86_400)),
  callOutcome: optionalField(z.string().trim().max(200)),
  location: optionalField(z.string().trim().max(200)),
  ticketId: optionalField(z.string().min(1)),
  contactId: optionalField(z.string().min(1)),
  accountId: optionalField(z.string().min(1)),
  assignedToId: optionalField(z.string().min(1)),
});
export type CreateActivityInput = z.infer<typeof createActivitySchema>;
export type ActivityFormValues = z.input<typeof createActivitySchema>;

export const updateActivitySchema = patchSchema(createActivitySchema.omit({ type: true })).extend({
  status: z.enum(ACTIVITY_STATUSES).optional(),
});
export type UpdateActivityInput = z.infer<typeof updateActivitySchema>;

export const listActivitiesQuerySchema = paginationQuerySchema.extend({
  type: z.enum(ACTIVITY_TYPES).optional(),
  status: z.enum(ACTIVITY_STATUSES).optional(),
  ticketId: z.string().min(1).optional(),
  contactId: z.string().min(1).optional(),
  accountId: z.string().min(1).optional(),
  assignedToId: z.string().min(1).optional(),
  assignedToMe: queryBoolean.optional(),
  overdue: queryBoolean.optional(),
});
export type ListActivitiesQuery = z.infer<typeof listActivitiesQuerySchema>;

// ---------------------------------------------------------------------------
// Assignment rules
// ---------------------------------------------------------------------------

export const ASSIGNMENT_STRATEGIES = [
  'SPECIFIC_AGENT',
  'DEPARTMENT',
  'ROUND_ROBIN',
  'LEAST_LOADED',
] as const;
export type AssignmentStrategy = (typeof ASSIGNMENT_STRATEGIES)[number];

const assignmentRuleBaseSchema = z.object({
  name: z.string().trim().min(1).max(120),
  isActive: z.boolean().default(true),
  position: z.number().int().min(0).max(9999).default(0),
  conditions: conditionTreeSchema.default({ all: [], any: [] }),
  strategy: z.enum(ASSIGNMENT_STRATEGIES),
  departmentId: optionalField(z.string().min(1)),
  teamId: optionalField(z.string().min(1)),
  agentId: optionalField(z.string().min(1)),
});

export const assignmentRuleSchema = assignmentRuleBaseSchema
  .refine(
    (rule) => rule.strategy !== 'SPECIFIC_AGENT' || Boolean(rule.agentId),
    { path: ['agentId'], message: 'Choose the agent to assign' },
  )
  .refine(
    (rule) =>
      rule.strategy === 'SPECIFIC_AGENT' || Boolean(rule.departmentId) || Boolean(rule.teamId),
    { path: ['departmentId'], message: 'Choose a department or team to route to' },
  );
export type AssignmentRuleInput = z.infer<typeof assignmentRuleSchema>;
export type AssignmentRuleFormValues = z.input<typeof assignmentRuleSchema>;

/**
 * Partial edits cannot carry the cross-field refinements (Zod refuses `.partial()` on a
 * refined schema); the service re-checks strategy targets on update instead.
 */
export const updateAssignmentRuleSchema = patchSchema(assignmentRuleBaseSchema);
export type UpdateAssignmentRuleInput = z.infer<typeof updateAssignmentRuleSchema>;

export const reorderSchema = z.object({ ids: z.array(z.string().min(1)).min(1).max(500) });

// ---------------------------------------------------------------------------
// Automation rules (escalations are rules on the SLA triggers)
// ---------------------------------------------------------------------------

export const AUTOMATION_TRIGGERS = [
  'TICKET_CREATED',
  'TICKET_UPDATED',
  'TICKET_ASSIGNED',
  'STATUS_CHANGED',
  'PRIORITY_CHANGED',
  'CUSTOMER_REPLIED',
  'AGENT_REPLIED',
  'SLA_WARNING',
  'SLA_BREACHED',
] as const;
export type AutomationTrigger = (typeof AUTOMATION_TRIGGERS)[number];

export const automationRuleSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: optionalField(z.string().trim().max(500)),
  isActive: z.boolean().default(true),
  position: z.number().int().min(0).max(9999).default(0),
  trigger: z.enum(AUTOMATION_TRIGGERS),
  conditions: conditionTreeSchema.default({ all: [], any: [] }),
  actions: actionListSchema.min(1),
});
export type AutomationRuleInput = z.infer<typeof automationRuleSchema>;
export type AutomationRuleFormValues = z.input<typeof automationRuleSchema>;

export const listAutomationRunsQuerySchema = paginationQuerySchema.extend({
  ruleId: z.string().min(1).optional(),
  ticketId: z.string().min(1).optional(),
  matched: queryBoolean.optional(),
});
export type ListAutomationRunsQuery = z.infer<typeof listAutomationRunsQuerySchema>;

// ---------------------------------------------------------------------------
// SLA
// ---------------------------------------------------------------------------

export const slaTargetSchema = z.object({
  priorityId: optionalField(z.string().min(1)),
  firstResponseMinutes: z.number().int().min(1).max(60 * 24 * 90),
  resolutionMinutes: z.number().int().min(1).max(60 * 24 * 365),
  useBusinessHours: z.boolean().default(true),
});
export type SlaTargetInput = z.infer<typeof slaTargetSchema>;

export const slaPolicySchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: optionalField(z.string().trim().max(500)),
  isActive: z.boolean().default(true),
  isDefault: z.boolean().default(false),
  position: z.number().int().min(0).max(9999).default(0),
  conditions: conditionTreeSchema.default({ all: [], any: [] }),
  businessHoursId: optionalField(z.string().min(1)),
  warningMinutesBefore: z.number().int().min(0).max(60 * 24 * 30).default(30),
  targets: z.array(slaTargetSchema).min(1).max(20),
});
export type SlaPolicyInput = z.infer<typeof slaPolicySchema>;
export type SlaPolicyFormValues = z.input<typeof slaPolicySchema>;

// ---------------------------------------------------------------------------
// Blueprints
// ---------------------------------------------------------------------------

export const TRANSITION_REQUIRED_FIELDS = [
  'resolutionNote',
  'assignedAgentId',
  'departmentId',
  'categoryId',
  'contactId',
  'tags',
] as const;
export type TransitionRequiredField = (typeof TRANSITION_REQUIRED_FIELDS)[number];

export const blueprintTransitionSchema = z.object({
  name: z.string().trim().min(1).max(120),
  fromStatusId: optionalField(z.string().min(1)),
  toStatusId: z.string().min(1),
  requiredFields: z.array(z.enum(TRANSITION_REQUIRED_FIELDS)).max(10).default([]),
  allowedRoleIds: z.array(z.string().min(1)).max(50).default([]),
  conditions: conditionTreeSchema.default({ all: [], any: [] }),
  actions: actionListSchema.default([]),
  position: z.number().int().min(0).max(9999).default(0),
});
export type BlueprintTransitionInput = z.infer<typeof blueprintTransitionSchema>;

export const blueprintSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: optionalField(z.string().trim().max(500)),
  isActive: z.boolean().default(true),
  position: z.number().int().min(0).max(9999).default(0),
  conditions: conditionTreeSchema.default({ all: [], any: [] }),
  transitions: z.array(blueprintTransitionSchema).min(1).max(100),
});
export type BlueprintInput = z.infer<typeof blueprintSchema>;
export type BlueprintFormValues = z.input<typeof blueprintSchema>;
