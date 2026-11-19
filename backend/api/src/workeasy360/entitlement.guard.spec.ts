import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UNCHECKED, type EntitlementAccess } from '@digisoft/workeasy360';
import { EntitlementExempt, EntitlementRead } from '../common/decorators/entitlement.decorator';
import { Public } from '../common/decorators/public.decorator';
import { AppError } from '../common/errors/app-error';
import { EntitlementGuard } from './entitlement.guard';
import type { EntitlementService } from './entitlement.service';
import { SessionAccessService } from './session-access.service';
import type { Workeasy360Settings } from './workeasy360.settings';

const LINKED = '3f1f6a3e-1f0e-4d6a-9c50-4c0a1c1e0b11';

class Handlers {
  plain(): void {}
  @Public()
  open(): void {}
  @EntitlementExempt()
  me(): void {}
  @EntitlementRead()
  readByPost(): void {}
}

function build(
  options: { enabled?: boolean; link?: string | null; access?: EntitlementAccess; ssoOnly?: boolean } = {},
) {
  const checks: { id: string; subject: string | undefined }[] = [];
  const links: string[] = [];
  const entitlements = {
    enabled: options.enabled ?? true,
    check: async (id: string, opts?: { subject?: string }) => {
      checks.push({ id, subject: opts?.subject });
      return options.access ?? { allowed: true, writeAllowed: true, reason: 'entitled', status: 'allow' };
    },
    linkedOrganizationId: async (organizationId: string) => {
      links.push(organizationId);
      return options.link === undefined ? LINKED : options.link;
    },
  } as unknown as EntitlementService;
  const settings = { ssoOnly: options.ssoOnly ?? false } as unknown as Workeasy360Settings;
  const guard = new EntitlementGuard(new Reflector(), entitlements, new SessionAccessService(settings, entitlements));

  const run = (
    handler: keyof Handlers,
    request: Record<string, unknown>,
  ): Promise<boolean> => {
    const context = {
      getHandler: () => Handlers.prototype[handler],
      getClass: () => Handlers,
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    return guard.canActivate(context);
  };
  return { run, checks, links };
}

const agent = { id: 'u1', organizationId: 'org1', type: 'AGENT' };
const signedIn = (extra: Record<string, unknown> = {}) => ({
  method: 'GET',
  user: agent,
  accessTokenPayload: { sub: 'u1', org: 'org1', typ: 'AGENT', w360: { org: LINKED, sub: 'subject-1' } },
  ...extra,
});

async function refusal(promise: Promise<unknown>): Promise<AppError> {
  const error = await promise.then(
    () => {
      throw new Error('expected a refusal');
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
}

describe('EntitlementGuard', () => {
  it('asks per person, with the subject the session was signed in with', async () => {
    const t = build();
    await expect(t.run('plain', signedIn())).resolves.toBe(true);
    expect(t.checks).toEqual([{ id: LINKED, subject: 'subject-1' }]);
  });

  it('asks about the organization when the session carries no subject (an account not yet linked)', async () => {
    const t = build();
    await t.run('plain', signedIn({ accessTokenPayload: { sub: 'u1', org: 'org1', typ: 'AGENT', w360: { org: LINKED } } }));
    expect(t.checks).toEqual([{ id: LINKED, subject: undefined }]);
  });

  it('never asks about an organization that is not bound to Workeasy360 (no claim)', async () => {
    const t = build();
    await expect(t.run('plain', signedIn({ accessTokenPayload: { sub: 'u1', org: 'org1', typ: 'AGENT' } }))).resolves.toBe(true);
    expect(t.checks).toHaveLength(0);
  });

  it('does nothing when Workeasy360 is not configured here', async () => {
    const t = build({ enabled: false });
    await expect(t.run('plain', signedIn())).resolves.toBe(true);
    expect(t.checks).toHaveLength(0);
  });

  it('skips public routes and routes marked exempt', async () => {
    const t = build({ access: { allowed: false, writeAllowed: false, reason: 'expired', status: 'deny' } });
    await expect(t.run('open', signedIn())).resolves.toBe(true);
    await expect(t.run('me', signedIn())).resolves.toBe(true);
    expect(t.checks).toHaveLength(0);
  });

  it('skips requests nobody signed in for', async () => {
    const t = build();
    await expect(t.run('plain', { method: 'GET' })).resolves.toBe(true);
    expect(t.checks).toHaveLength(0);
  });

  it('refuses a denied person with WORKEASY360_ACCESS_ENDED and the reason', async () => {
    const t = build({ access: { allowed: false, writeAllowed: false, reason: 'membership_inactive', status: 'deny' } });
    const error = await refusal(t.run('plain', signedIn()));
    expect(error.getStatus()).toBe(403);
    expect(error.code).toBe('WORKEASY360_ACCESS_ENDED');
    expect(error.details).toEqual({ reason: 'membership_inactive' });
  });

  it('refuses reads as well as writes once access ended', async () => {
    const t = build({ access: { allowed: false, writeAllowed: false, reason: 'expired', status: 'deny' } });
    for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
      expect((await refusal(t.run('plain', signedIn({ method })))).code).toBe('WORKEASY360_ACCESS_ENDED');
    }
  });

  it('refuses writes, but not reads, while the organization is read-only', async () => {
    const t = build({ access: { allowed: true, writeAllowed: false, reason: 'read_only', status: 'allow' } });
    await expect(t.run('plain', signedIn({ method: 'GET' }))).resolves.toBe(true);
    await expect(t.run('plain', signedIn({ method: 'HEAD' }))).resolves.toBe(true);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const error = await refusal(t.run('plain', signedIn({ method })));
      expect(error.code).toBe('WORKEASY360_READ_ONLY');
      expect(error.getStatus()).toBe(403);
    }
  });

  it('lets a read made with POST through while read-only (EntitlementRead)', async () => {
    const t = build({ access: { allowed: true, writeAllowed: false, reason: 'read_only', status: 'allow' } });
    await expect(t.run('readByPost', signedIn({ method: 'POST' }))).resolves.toBe(true);
  });

  it('fails closed with WORKEASY360_ACCESS_UNVERIFIED when Workeasy360 refused our own client', async () => {
    const t = build({ access: { allowed: false, writeAllowed: false, reason: 'refused', status: 'refused' } });
    expect((await refusal(t.run('plain', signedIn()))).code).toBe('WORKEASY360_ACCESS_UNVERIFIED');
  });

  it('lets everything through when no answer was ever available (an outage is never a denial)', async () => {
    const t = build({ access: UNCHECKED });
    await expect(t.run('plain', signedIn({ method: 'POST' }))).resolves.toBe(true);
  });

  describe('SSO-only: a session without a Workeasy360 identity in a bound organization', () => {
    const passwordEra = {
      method: 'GET',
      user: agent,
      accessTokenPayload: { sub: 'u1', org: 'org1', typ: 'AGENT', w360: { org: LINKED } },
    };

    it('is refused with WORKEASY360_SIGN_IN_REQUIRED, without asking Workeasy360', async () => {
      const t = build({ ssoOnly: true });
      const error = await refusal(t.run('plain', passwordEra));
      expect(error.code).toBe('WORKEASY360_SIGN_IN_REQUIRED');
      expect(error.getStatus()).toBe(403);
      expect(t.checks).toHaveLength(0);
    });

    it('is refused even on a route exempt from the entitlement (/auth/me)', async () => {
      const t = build({ ssoOnly: true });
      expect((await refusal(t.run('me', passwordEra))).code).toBe('WORKEASY360_SIGN_IN_REQUIRED');
    });

    it('is accepted when SSO-only is off (development keeps today\'s behaviour), asked per organization', async () => {
      const t = build({ ssoOnly: false });
      await expect(t.run('plain', passwordEra)).resolves.toBe(true);
      expect(t.checks).toEqual([{ id: LINKED, subject: undefined }]);
    });

    it('does not touch an organization that is not bound to Workeasy360', async () => {
      const t = build({ ssoOnly: true });
      await expect(
        t.run('plain', { ...passwordEra, accessTokenPayload: { sub: 'u1', org: 'org1', typ: 'AGENT' } }),
      ).resolves.toBe(true);
    });

    it('lets a session with a Workeasy360 identity through', async () => {
      const t = build({ ssoOnly: true });
      await expect(t.run('plain', signedIn())).resolves.toBe(true);
    });

    it('keeps API keys at the organization level', async () => {
      const t = build({ ssoOnly: true });
      await expect(t.run('plain', { method: 'POST', user: agent, apiKeyAuthenticated: true })).resolves.toBe(true);
      expect(t.checks).toEqual([{ id: LINKED, subject: undefined }]);
    });
  });

  it('asks about the organization for an API key, which has no person', async () => {
    const t = build();
    await t.run('plain', { method: 'POST', user: agent, apiKeyAuthenticated: true });
    expect(t.links).toEqual(['org1']);
    expect(t.checks).toEqual([{ id: LINKED, subject: undefined }]);
  });

  it('skips an API key of an unbound organization', async () => {
    const t = build({ link: null });
    await expect(t.run('plain', { method: 'POST', user: agent, apiKeyAuthenticated: true })).resolves.toBe(true);
    expect(t.checks).toHaveLength(0);
  });
});
