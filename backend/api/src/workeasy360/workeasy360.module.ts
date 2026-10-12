import { Global, Module } from '@nestjs/common';
import { EntitlementGuard } from './entitlement.guard';
import { EntitlementService } from './entitlement.service';
import { SessionAccessService } from './session-access.service';
import { Workeasy360AuthController } from './workeasy360-auth.controller';
import { Workeasy360ClientProvider } from './workeasy360-client.provider';
import { Workeasy360ProvisioningService } from './workeasy360-provisioning.service';

/**
 * "Sign in with Workeasy360": the browser routes, provisioning, and the entitlement checks
 * that keep asking while a session lasts. Global because the entitlement service is also used
 * by the help center guard; the settings it builds on live in the auth module.
 */
@Global()
@Module({
  controllers: [Workeasy360AuthController],
  providers: [
    Workeasy360ClientProvider,
    Workeasy360ProvisioningService,
    EntitlementService,
    SessionAccessService,
    EntitlementGuard,
  ],
  exports: [EntitlementService, SessionAccessService, EntitlementGuard, Workeasy360ClientProvider],
})
export class Workeasy360Module {}
