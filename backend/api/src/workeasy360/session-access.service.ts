import { Injectable } from '@nestjs/common';
import type { AccessTokenPayload } from '../auth/token.service';
import { AppError } from '../common/errors/app-error';
import { EntitlementService } from './entitlement.service';
import { Workeasy360Settings } from './workeasy360.settings';

export type AccessRefusalCode =
  | 'WORKEASY360_SIGN_IN_REQUIRED'
  | 'WORKEASY360_ACCESS_ENDED'
  | 'WORKEASY360_ACCESS_UNVERIFIED';

export type AccessDecision =
  | { ok: true; writeAllowed: boolean }
  | { ok: false; code: AccessRefusalCode; message: string; reason?: string };

/** What identifies the caller for an access decision. */
export type AccessSubject =
  /** A signed-in agent: the access token's `w360` claim. */
  | { kind: 'token'; w360: AccessTokenPayload['w360'] }
  /** A machine caller: no person, the organization only. */
  | { kind: 'organization'; workeasyOrganizationId: string | null };

/**
 * Is this agent session still allowed to use the product? The one place the rules live, so
 * HTTP requests, portal requests made with an agent token and open realtime sockets cannot
 * disagree:
 *
 * 1. SSO-only: a session in an organization bound to Workeasy360 whose user has no Workeasy360
 *    identity (a password-era session) is refused - the person signs in with Workeasy360,
 *    which links the account by verified email.
 * 2. Otherwise Workeasy360 is asked (per person when the session has a `sub`, else per
 *    organization) on the entitlement cache cadence.
 */
@Injectable()
export class SessionAccessService {
  constructor(
    private readonly settings: Workeasy360Settings,
    private readonly entitlements: EntitlementService,
  ) {}

  /** The sign-in-required rule alone (no I/O). Checked even on routes exempt from the entitlement. */
  signInRequired(w360: AccessTokenPayload['w360']): AccessDecision | null {
    if (this.settings.ssoOnly && w360 && !w360.sub) {
      return {
        ok: false,
        code: 'WORKEASY360_SIGN_IN_REQUIRED',
        message:
          'Sign in with Workeasy360 to continue. Your account is linked to your Workeasy360 account when you do.',
      };
    }
    return null;
  }

  async evaluate(subject: AccessSubject): Promise<AccessDecision> {
    let organization: string | null;
    let person: string | undefined;
    if (subject.kind === 'token') {
      const required = this.signInRequired(subject.w360);
      if (required) return required;
      organization = subject.w360?.org ?? null;
      person = subject.w360?.sub;
    } else {
      organization = subject.workeasyOrganizationId;
    }
    if (!organization || !this.entitlements.enabled) return { ok: true, writeAllowed: true };

    const access = await this.entitlements.check(organization, person ? { subject: person } : {});
    if (access.status === 'refused') {
      return {
        ok: false,
        code: 'WORKEASY360_ACCESS_UNVERIFIED',
        message:
          'Easy Help Desk cannot confirm your access with Workeasy360 at the moment. Try again in a few minutes; if this continues, contact support.',
        reason: access.reason,
      };
    }
    if (!access.allowed) {
      return {
        ok: false,
        code: 'WORKEASY360_ACCESS_ENDED',
        message: 'Your access to Easy Help Desk has ended. An owner can renew it in Workeasy360.',
        reason: access.reason,
      };
    }
    return { ok: true, writeAllowed: access.writeAllowed };
  }

  /** The refusal as the HTTP error the API answers with. */
  static toError(decision: Extract<AccessDecision, { ok: false }>): AppError {
    return new AppError(
      decision.code,
      decision.message,
      403,
      decision.reason ? { reason: decision.reason } : undefined,
    );
  }
}
