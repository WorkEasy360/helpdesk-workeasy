import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import {
  PERMISSIONS,
  businessHoursSchema,
  holidaySchema,
  updateOrganizationSchema,
  type AuthenticatedUser,
  type BusinessHoursInput,
  type HolidayInput,
  type UpdateOrganizationInput,
  patchSchema,
} from '@digisoft/shared';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { zodBody } from '../common/pipes/zod-validation.pipe';
import { OrganizationsService } from './organizations.service';

@Controller('organizations')
export class OrganizationsController {
  constructor(private readonly organizations: OrganizationsService) {}

  @RequirePermissions(PERMISSIONS.ORGANIZATION_READ)
  @Get('current')
  findCurrent(@CurrentUser() user: AuthenticatedUser) {
    return this.organizations.findCurrent(user.organizationId);
  }

  @RequirePermissions(PERMISSIONS.ORGANIZATION_UPDATE)
  @Patch('current')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(updateOrganizationSchema)) dto: UpdateOrganizationInput,
  ) {
    return this.organizations.update(user, dto);
  }

  @RequirePermissions(PERMISSIONS.ORGANIZATION_READ)
  @Get('current/business-hours')
  listBusinessHours() {
    return this.organizations.listBusinessHours();
  }

  @RequirePermissions(PERMISSIONS.ORGANIZATION_UPDATE)
  @Post('current/business-hours')
  createBusinessHours(
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(businessHoursSchema)) dto: BusinessHoursInput,
  ) {
    return this.organizations.createBusinessHours(user, dto);
  }

  @RequirePermissions(PERMISSIONS.ORGANIZATION_UPDATE)
  @Patch('current/business-hours/:id')
  updateBusinessHours(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(patchSchema(businessHoursSchema))) dto: Partial<BusinessHoursInput>,
  ) {
    return this.organizations.updateBusinessHours(id, user, dto);
  }

  @RequirePermissions(PERMISSIONS.ORGANIZATION_UPDATE)
  @Post('current/business-hours/:id/holidays')
  addHoliday(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(holidaySchema)) dto: HolidayInput,
  ) {
    return this.organizations.addHoliday(id, user, dto);
  }

  @RequirePermissions(PERMISSIONS.ORGANIZATION_UPDATE)
  @Delete('current/holidays/:id')
  async removeHoliday(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    await this.organizations.removeHoliday(id, user);
    return { deleted: true };
  }
}
