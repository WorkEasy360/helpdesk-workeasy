import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { NextFunction, Request, Response } from 'express';
import { TenantContext } from '@digisoft/db';
import type { AccessTokenPayload, VerifyResult } from '../../auth/token.service';
import type { SessionState } from '../../auth/session-liveness.service';
import { AppError } from '../errors/app-error';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { TenantContextMiddleware } from './tenant-context.middleware';

const claims: AccessTokenPayload = {
  sub: 'user-1',
  org: 'org-1',
  email: 'ada@example.test',
  typ: 'AGENT',
  fam: 'family-1',
};

function build(verify: VerifyResult, state: () => Promise<SessionState>) {
  const tokens = { verifyAccessToken: jest.fn(() => verify) };
  const sessions = { state: jest.fn(state) };
  const apiKeys = { authenticate: jest.fn() };
  const middleware = new TenantContextMiddleware(tokens as never, sessions as never, apiKeys as never);
  return { middleware, sessions };
}

/** Runs the middleware; resolves with the request and the tenant scope `next` ran in. */
function run(middleware: TenantContextMiddleware, headers: Record<string, string> = { authorization: 'Bearer token' }) {
  return new Promise<{ req: Request; tenant: string | undefined }>((resolve) => {
    const req = { headers } as unknown as Request;
    const next: NextFunction = () => resolve({ req, tenant: TenantContext.organizationId ?? undefined });
    middleware.use(req, {} as Response, next);
  });
}

describe('TenantContextMiddleware: a token is an identity only while its session is open', () => {
  it('an open session: the claims are the identity and the tenant scope is opened', async () => {
    const { middleware, sessions } = build({ ok: true, payload: claims }, async () => 'live' as const);
    const { req, tenant } = await run(middleware);
    expect(sessions.state).toHaveBeenCalledWith(claims);
    expect(req.accessTokenPayload).toBe(claims);
    expect(req.authError).toBeUndefined();
    expect(tenant).toBe('org-1');
  });

  it('a deactivated or deleted account: no identity, marked disabled (the more precise reason)', async () => {
    const { middleware } = build({ ok: true, payload: claims }, async () => 'account_disabled' as const);
    const { req, tenant } = await run(middleware);
    expect(req.accessTokenPayload).toBeUndefined();
    expect(req.authError).toBe('disabled');
    expect(tenant).toBeUndefined();
  });

  it('an ended session: no identity and no tenant scope, as if no token had been sent', async () => {
    const { middleware } = build({ ok: true, payload: claims }, async () => 'ended' as const);
    const { req, tenant } = await run(middleware);
    expect(req.accessTokenPayload).toBeUndefined();
    expect(req.authError).toBe('ended');
    expect(tenant).toBeUndefined();
  });

  it('a session that cannot be checked: no identity either, marked unverified (not ended)', async () => {
    const { middleware } = build({ ok: true, payload: claims }, async () => {
      throw new Error('the database went away');
    });
    const { req, tenant } = await run(middleware);
    expect(req.accessTokenPayload).toBeUndefined();
    expect(req.authError).toBe('unverified');
    expect(tenant).toBeUndefined();
  });

  it('asks nothing for a token that does not verify, or for no token', async () => {
    const invalid = build({ ok: false, reason: 'expired' }, async () => 'live' as const);
    expect((await run(invalid.middleware)).req.authError).toBe('expired');
    expect(invalid.sessions.state).not.toHaveBeenCalled();

    const none = build({ ok: true, payload: claims }, async () => 'live' as const);
    const { req } = await run(none.middleware, {});
    expect(req.accessTokenPayload).toBeUndefined();
    expect(req.authError).toBeUndefined();
    expect(none.sessions.state).not.toHaveBeenCalled();
  });
});

describe('JwtAuthGuard answers for an ended, disabled or unverifiable session', () => {
  const guard = new JwtAuthGuard(
    { getAllAndOverride: () => false } as unknown as Reflector,
    { resolveUser: jest.fn() } as never,
  );
  const context = (req: Partial<Request>) =>
    ({
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => req }),
    }) as unknown as ExecutionContext;

  async function refusal(req: Partial<Request>): Promise<{ status: number; code: string }> {
    try {
      await guard.canActivate(context(req));
    } catch (error) {
      if (error instanceof AppError) return { status: error.getStatus(), code: error.code };
      throw error;
    }
    throw new Error('the guard let the request through');
  }

  it('401 SESSION_ENDED for an ended session, so the app renews once and signs out', async () => {
    expect(await refusal({ authError: 'ended' })).toEqual({ status: 401, code: 'SESSION_ENDED' });
  });

  it('401 ACCOUNT_DISABLED for a deactivated account, as before sessions were checked', async () => {
    expect(await refusal({ authError: 'disabled' })).toEqual({ status: 401, code: 'ACCOUNT_DISABLED' });
  });

  it('503 SERVICE_UNAVAILABLE when the session could not be checked: nobody is signed out by an outage', async () => {
    expect(await refusal({ authError: 'unverified' })).toEqual({ status: 503, code: 'SERVICE_UNAVAILABLE' });
  });
});
