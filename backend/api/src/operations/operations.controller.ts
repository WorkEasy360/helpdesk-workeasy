import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import {
  PERMISSIONS,
  assignmentRuleSchema,
  automationRuleSchema,
  blueprintSchema,
  listAutomationRunsQuerySchema,
  queryBoolean,
  reorderSchema,
  slaPolicySchema,
  updateAssignmentRuleSchema,
  type AssignmentRuleInput,
  type AuthenticatedUser,
  type AutomationRuleInput,
  type BlueprintInput,
  type ListAutomationRunsQuery,
  type SlaPolicyInput,
  patchSchema,
} from '@digisoft/shared';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { zodBody } from '../common/pipes/zod-validation.pipe';
import { AssignmentRulesService } from './assignment-rules.service';
import { AutomationRulesService } from './automation-rules.service';
import { SlaPoliciesService } from './sla-policies.service';
import { BlueprintsService } from './blueprints.service';

const listRulesQuery = z.object({ escalations: queryBoolean.optional() });

@Controller()
export class OperationsController {
  constructor(
    private readonly assignment: AssignmentRulesService,
    private readonly automation: AutomationRulesService,
    private readonly sla: SlaPoliciesService,
    private readonly blueprints: BlueprintsService,
  ) {}

  // --- assignment rules ---
  @RequirePermissions(PERMISSIONS.OPERATIONS_READ) @Get('assignment-rules')
  listAssignment() { return this.assignment.list(); }

  @RequirePermissions(PERMISSIONS.OPERATIONS_MANAGE) @Post('assignment-rules')
  createAssignment(@CurrentUser() user: AuthenticatedUser, @Body(zodBody(assignmentRuleSchema)) dto: AssignmentRuleInput) {
    return this.assignment.create(user, dto);
  }

  @RequirePermissions(PERMISSIONS.OPERATIONS_MANAGE) @Patch('assignment-rules/reorder')
  async reorderAssignment(@CurrentUser() user: AuthenticatedUser, @Body(zodBody(reorderSchema)) dto: { ids: string[] }) {
    await this.assignment.reorder(user, dto.ids);
    return this.assignment.list();
  }

  @RequirePermissions(PERMISSIONS.OPERATIONS_MANAGE) @Patch('assignment-rules/:id')
  updateAssignment(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser, @Body(zodBody(updateAssignmentRuleSchema)) dto: Partial<AssignmentRuleInput>) {
    return this.assignment.update(id, user, dto);
  }

  @RequirePermissions(PERMISSIONS.OPERATIONS_MANAGE) @Delete('assignment-rules/:id')
  async removeAssignment(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    await this.assignment.remove(id, user);
    return { deleted: true };
  }

  // --- automation rules and escalations ---
  @RequirePermissions(PERMISSIONS.OPERATIONS_READ) @Get('automation-rules')
  listAutomation(@Query(zodBody(listRulesQuery)) query: { escalations?: boolean }) { return this.automation.list(query.escalations); }

  @RequirePermissions(PERMISSIONS.OPERATIONS_READ) @Get('automation-rules/runs')
  listRuns(@Query(zodBody(listAutomationRunsQuerySchema)) query: ListAutomationRunsQuery) { return this.automation.listRuns(query); }

  @RequirePermissions(PERMISSIONS.OPERATIONS_READ) @Get('automation-rules/:id')
  findAutomation(@Param('id') id: string) { return this.automation.findById(id); }

  @RequirePermissions(PERMISSIONS.OPERATIONS_MANAGE) @Post('automation-rules')
  createAutomation(@CurrentUser() user: AuthenticatedUser, @Body(zodBody(automationRuleSchema)) dto: AutomationRuleInput) {
    return this.automation.create(user, dto);
  }

  @RequirePermissions(PERMISSIONS.OPERATIONS_MANAGE) @Patch('automation-rules/:id')
  updateAutomation(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser, @Body(zodBody(patchSchema(automationRuleSchema))) dto: Partial<AutomationRuleInput>) {
    return this.automation.update(id, user, dto);
  }

  @RequirePermissions(PERMISSIONS.OPERATIONS_MANAGE) @HttpCode(HttpStatus.OK) @Post('automation-rules/:id/enable')
  enableAutomation(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) { return this.automation.setActive(id, user, true); }

  @RequirePermissions(PERMISSIONS.OPERATIONS_MANAGE) @HttpCode(HttpStatus.OK) @Post('automation-rules/:id/disable')
  disableAutomation(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) { return this.automation.setActive(id, user, false); }

  @RequirePermissions(PERMISSIONS.OPERATIONS_MANAGE) @Delete('automation-rules/:id')
  async removeAutomation(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    await this.automation.remove(id, user);
    return { deleted: true };
  }

  // --- SLA policies ---
  @RequirePermissions(PERMISSIONS.OPERATIONS_READ) @Get('sla-policies')
  listSla() { return this.sla.list(); }

  @RequirePermissions(PERMISSIONS.OPERATIONS_READ) @Get('sla-policies/:id')
  findSla(@Param('id') id: string) { return this.sla.findById(id); }

  @RequirePermissions(PERMISSIONS.OPERATIONS_MANAGE) @Post('sla-policies')
  createSla(@CurrentUser() user: AuthenticatedUser, @Body(zodBody(slaPolicySchema)) dto: SlaPolicyInput) { return this.sla.create(user, dto); }

  @RequirePermissions(PERMISSIONS.OPERATIONS_MANAGE) @Patch('sla-policies/:id')
  updateSla(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser, @Body(zodBody(slaPolicySchema)) dto: SlaPolicyInput) {
    return this.sla.update(id, user, dto);
  }

  @RequirePermissions(PERMISSIONS.OPERATIONS_MANAGE) @Delete('sla-policies/:id')
  async removeSla(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    await this.sla.remove(id, user);
    return { deleted: true };
  }

  // --- blueprints ---
  @RequirePermissions(PERMISSIONS.OPERATIONS_READ) @Get('blueprints')
  listBlueprints() { return this.blueprints.list(); }

  @RequirePermissions(PERMISSIONS.OPERATIONS_READ) @Get('blueprints/:id')
  findBlueprint(@Param('id') id: string) { return this.blueprints.findById(id); }

  @RequirePermissions(PERMISSIONS.OPERATIONS_MANAGE) @Post('blueprints')
  createBlueprint(@CurrentUser() user: AuthenticatedUser, @Body(zodBody(blueprintSchema)) dto: BlueprintInput) { return this.blueprints.create(user, dto); }

  @RequirePermissions(PERMISSIONS.OPERATIONS_MANAGE) @Patch('blueprints/:id')
  updateBlueprint(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser, @Body(zodBody(blueprintSchema)) dto: BlueprintInput) {
    return this.blueprints.update(id, user, dto);
  }

  @RequirePermissions(PERMISSIONS.OPERATIONS_MANAGE) @Delete('blueprints/:id')
  async removeBlueprint(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    await this.blueprints.remove(id, user);
    return { deleted: true };
  }
}
