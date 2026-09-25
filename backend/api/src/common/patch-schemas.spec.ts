import {
  automationRuleSchema,
  businessHoursSchema,
  patchSchema,
  ticketPrioritySchema,
  ticketStatusSchema,
  updateAccountSchema,
  updateActivitySchema,
  updateChannelSchema,
  updateCommunityCategorySchema,
  updateContactSchema,
  updateDepartmentSchema,
  updateKbArticleSchema,
  updateKbCategorySchema,
  updateRoleSchema,
  updateTeamSchema,
  updateWebFormSchema,
  updateWebhookEndpointSchema,
} from '@digisoft/shared';

/**
 * PATCH bodies must only carry what the client sent. With Zod 4, `.partial()` still
 * fills in `.default()` values, so renaming a role used to arrive with
 * `permissionKeys: []` and wipe its permissions.
 */
describe('update schemas', () => {
  const schemas = {
    updateAccountSchema,
    updateActivitySchema,
    updateChannelSchema,
    updateCommunityCategorySchema,
    updateContactSchema,
    updateDepartmentSchema,
    updateKbArticleSchema,
    updateKbCategorySchema,
    updateRoleSchema,
    updateTeamSchema,
    updateWebFormSchema,
    updateWebhookEndpointSchema,
    ticketStatus: patchSchema(ticketStatusSchema),
    ticketPriority: patchSchema(ticketPrioritySchema),
    businessHours: patchSchema(businessHoursSchema),
    automationRule: patchSchema(automationRuleSchema),
  };

  it.each(Object.entries(schemas))('%s adds nothing to an empty body', (_name, schema) => {
    expect(schema.parse({})).toEqual({});
  });

  it('keeps what was sent and nothing else', () => {
    expect(updateRoleSchema.parse({ name: 'Renamed' })).toEqual({ name: 'Renamed' });
    expect(updateTeamSchema.parse({ name: 'Ops' })).toEqual({ name: 'Ops' });
  });

  it('still validates the fields that are sent', () => {
    expect(() => updateRoleSchema.parse({ name: 'x' })).toThrow();
    expect(() => updateWebhookEndpointSchema.parse({ url: 'http://localhost/hook' })).toThrow();
  });
});
