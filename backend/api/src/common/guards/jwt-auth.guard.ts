import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { AppError } from '../errors/app-error';
import { AccessControlService } from '../../auth/access-control.service';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly accessControl: AccessControlService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();

    // An API key was already resolved to its service user by the middleware.
    if (request.apiKeyAuthenticated && request.user) {
      return true;
    }

    if (request.authError === 'expired') {
      throw AppError.unauthenticated('Access token has expired', 'TOKEN_EXPIRED');
    }
    const refusal = sessionRefusal(request.authError);
    if (refusal) {
      throw refusal;
    }
    if (request.authError === 'invalid' || !request.accessTokenPayload) {
      throw AppError.unauthenticated();
    }

    // Resolved per request (Redis-cached) so a revoked role stops working immediately
    // instead of at the next token refresh.
    const user = await this.accessControl.resolveUser(request.accessTokenPayload);
    // Agent routes are for agents. A help center customer holds a token of the same shape
    // (their own cookie, their own refresh route), and a route that asks for no particular
    // permission would otherwise answer them. Portal routes are public and run PortalGuard.
    if (user.type !== 'AGENT') {
      throw AppError.forbidden('This resource is for agents', 'FORBIDDEN');
    }
    request.user = user;
    return true;
  }
}

/**
 * What a token that verified but is not an open session is answered (TenantContextMiddleware
 * decided which), on agent and help center routes alike; null for anything else.
 *
 * - `ended`: its session has ended (a back-channel logout, Sign out, a password change...), or it
 *   names none. A 401 like an expired token, so the app makes its one renewal, which fails for an
 *   ended session and signs the page out.
 * - `disabled`: the account is deactivated or deleted (its sessions were ended with it); the more
 *   precise 401 it always got.
 * - `unverified`: the session could not be checked. A 503, never a 401, so nobody is signed out
 *   by an outage.
 */
export function sessionRefusal(authError: Request['authError']): AppError | null {
  switch (authError) {
    case 'ended':
      return AppError.unauthenticated('Your session has ended. Sign in again.', 'SESSION_ENDED');
    case 'disabled':
      return AppError.unauthenticated('Account is no longer active', 'ACCOUNT_DISABLED');
    case 'unverified':
      return new AppError(
        'SERVICE_UNAVAILABLE',
        'Your session could not be checked just now. Try again in a moment.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    default:
      return null;
  }
}
