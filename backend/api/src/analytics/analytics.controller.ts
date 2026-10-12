import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  PERMISSIONS,
  analyticsQuerySchema,
  csatSettingsSchema,
  reportDefinitionSchema,
  reportExportSchema,
  updateReportDefinitionSchema,
  type AnalyticsQuery,
  type AuthenticatedUser,
  type CsatSettingsInput,
  type ReportDefinitionInput,
  type ReportExportInput,
  type UpdateReportDefinitionInput,
} from '@digisoft/shared';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { EntitlementRead } from '../common/decorators/entitlement.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { zodBody } from '../common/pipes/zod-validation.pipe';
import { AppError } from '../common/errors/app-error';
import { AnalyticsService } from './analytics.service';
import { CsatService } from './csat.service';
import { ReportDefinitionsService } from './report-definitions.service';
import { ReportExportsService } from './report-exports.service';

@Controller()
export class AnalyticsController {
  constructor(
    private readonly analytics: AnalyticsService,
    private readonly definitions: ReportDefinitionsService,
    private readonly exports: ReportExportsService,
    private readonly csat: CsatService,
  ) {}

  @RequirePermissions(PERMISSIONS.REPORT_READ)
  @Get('dashboard')
  dashboard(
    @CurrentUser() user: AuthenticatedUser,
    @Query(zodBody(analyticsQuerySchema)) query: AnalyticsQuery,
  ) {
    return this.analytics.dashboard(user.organizationId, query);
  }

  @RequirePermissions(PERMISSIONS.REPORT_READ)
  @Get('reports/tickets')
  tickets(
    @CurrentUser() user: AuthenticatedUser,
    @Query(zodBody(analyticsQuerySchema)) query: AnalyticsQuery,
  ) {
    return this.analytics.report(user.organizationId, 'TICKETS', query);
  }

  @RequirePermissions(PERMISSIONS.REPORT_READ)
  @Get('reports/agents')
  agents(
    @CurrentUser() user: AuthenticatedUser,
    @Query(zodBody(analyticsQuerySchema)) query: AnalyticsQuery,
  ) {
    return this.analytics.report(user.organizationId, 'AGENTS', query);
  }

  @RequirePermissions(PERMISSIONS.REPORT_READ)
  @Get('reports/sla')
  sla(
    @CurrentUser() user: AuthenticatedUser,
    @Query(zodBody(analyticsQuerySchema)) query: AnalyticsQuery,
  ) {
    return this.analytics.report(user.organizationId, 'SLA', query);
  }

  @RequirePermissions(PERMISSIONS.REPORT_READ)
  @Get('reports/csat')
  csatReport(
    @CurrentUser() user: AuthenticatedUser,
    @Query(zodBody(analyticsQuerySchema)) query: AnalyticsQuery,
  ) {
    return this.analytics.report(user.organizationId, 'CSAT', query);
  }

  @RequirePermissions(PERMISSIONS.REPORT_READ)
  @Get('reports/exports')
  listExports() {
    return this.exports.list();
  }

  @RequirePermissions(PERMISSIONS.REPORT_READ)
  // Data portability: a read-only organization can still export what it has.
  @EntitlementRead()
  @Post('reports/export')
  createExport(
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(reportExportSchema)) dto: ReportExportInput,
  ) {
    return this.exports.create(user, dto);
  }

  @RequirePermissions(PERMISSIONS.REPORT_READ)
  @Get('reports/exports/:id')
  getExport(@Param('id') id: string) {
    return this.exports.get(id);
  }

  /** Object storage answers with a signed URL; local storage is streamed through here. */
  @RequirePermissions(PERMISSIONS.REPORT_READ)
  @Get('reports/exports/:id/download')
  async download(@Param('id') id: string, @Res() res: Response): Promise<void> {
    const { target, fileName } = await this.exports.download(id);
    if (target.url) {
      res.redirect(302, target.url);
      return;
    }
    if (!target.stream) throw AppError.notFound('Export file');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // A file that is missing from storage must fail this request, not the process: an
    // unhandled stream error takes the whole API down.
    target.stream.on('error', () => {
      if (!res.headersSent) res.status(500);
      res.end();
    });
    target.stream.pipe(res);
  }

  @RequirePermissions(PERMISSIONS.REPORT_READ)
  @Get('report-definitions')
  listDefinitions() {
    return this.definitions.list();
  }

  @RequirePermissions(PERMISSIONS.REPORT_MANAGE)
  @Post('report-definitions')
  createDefinition(
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(reportDefinitionSchema)) dto: ReportDefinitionInput,
  ) {
    return this.definitions.create(user, dto);
  }

  @RequirePermissions(PERMISSIONS.REPORT_READ)
  @Get('report-definitions/:id')
  getDefinition(@Param('id') id: string) {
    return this.definitions.get(id);
  }

  @RequirePermissions(PERMISSIONS.REPORT_MANAGE)
  @Patch('report-definitions/:id')
  updateDefinition(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(zodBody(updateReportDefinitionSchema)) dto: UpdateReportDefinitionInput,
  ) {
    return this.definitions.update(user, id, dto);
  }

  @RequirePermissions(PERMISSIONS.REPORT_MANAGE)
  @Delete('report-definitions/:id')
  removeDefinition(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.definitions.remove(user, id);
  }

  @RequirePermissions(PERMISSIONS.REPORT_READ)
  @Get('csat/settings')
  csatSettings(@CurrentUser() user: AuthenticatedUser) {
    return this.csat.settings(user.organizationId);
  }

  @RequirePermissions(PERMISSIONS.REPORT_MANAGE)
  @Patch('csat/settings')
  updateCsatSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(csatSettingsSchema)) dto: CsatSettingsInput,
  ) {
    return this.csat.updateSettings(user, dto);
  }

  @RequirePermissions(PERMISSIONS.TICKET_READ)
  @Get('tickets/:id/csat')
  ticketCsat(@Param('id') id: string) {
    return this.csat.forTicket(id);
  }
}
