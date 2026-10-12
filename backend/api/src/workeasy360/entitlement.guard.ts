import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from '../common/decorators/public.decorator';
import { ENTITLEMENT_EXEMPT_KEY, ENTITLEMENT_READ_KEY } from '../common/decorators/entitlement.decorator';
import { AppError } from '../common/errors/app-error';
import { EntitlementService } from './entitlement.service';
import { SessionAccessService } from './session-access.service';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Sign-in checked the organization's entitlement once; a session then lives on. This asks
 * again, on a cadence, for every signed-in request of an organization bound to Workeasy360
 * (completion design section 4):
 *
 * - a person's request is asked per person, so a removed member, a disabled account or an
 *   unassigned seat stops working within one window, not at the end of the session;
 * - `deny` is 403 WORKEASY360_ACCESS_ENDED, a read-only organization refuses writes with
 *   WORKEASY360_READ_ONLY, and a refusal of our own client is WORKEASY360_ACCESS_UNVERIFIED;
 * - in SSO-only mode a session without a Workeasy360 identity (password era) in a bound
 *   organization is 403 WORKEASY360_SIGN_IN_REQUIRED, on every route that is not public;
 * - the session itself stays valid, so the person sees one "access has ended" screen and
 *   can sign out. `/auth/me`, sign-out, refresh, the methods read, health and the sign-in
 *   routes are public or marked exempt from the entitlement (not from the sign-in rule).
 *
 * An organization that is not bound to Workeasy360 is never checked.
 */
@Injectable()
export class EntitlementGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly entitlements: EntitlementService,
    private readonly access: SessionAccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const user = request.user;
    if (!user) return true;

    const w360 = request.apiKeyAuthenticated ? undefined : request.accessTokenPayload?.w360;
    const required = this.access.signInRequired(w360);
    if (required && !required.ok) throw SessionAccessService.toError(required);

    if (this.reflector.getAllAndOverride<boolean>(ENTITLEMENT_EXEMPT_KEY, targets)) return true;
    if (!this.entitlements.enabled) return true;

    // A machine caller has no person: ask about the organization.
    const decision = request.apiKeyAuthenticated
      ? await this.access.evaluate({
          kind: 'organization',
          workeasyOrganizationId: await this.entitlements.linkedOrganizationId(user.organizationId),
        })
      : await this.access.evaluate({ kind: 'token', w360 });
    if (!decision.ok) throw SessionAccessService.toError(decision);

    const write =
      !SAFE_METHODS.has(request.method) && !this.reflector.getAllAndOverride<boolean>(ENTITLEMENT_READ_KEY, targets);
    if (write && !decision.writeAllowed) {
      throw new AppError(
        'WORKEASY360_READ_ONLY',
        'Your Easy Help Desk subscription is read-only at the moment: you can view and export but not change anything. An owner can resolve this in Workeasy360.',
        403,
        { reason: 'read_only' },
      );
    }
    return true;
  }
}
