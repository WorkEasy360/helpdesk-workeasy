import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import type {
  AuthenticatedUser,
  ChangePasswordInput,
  ForgotPasswordInput,
  LoginInput,
  LoginResponse,
  OrganizationChoiceResponse,
  RegisterInput,
  ResetPasswordInput,
  UpdateUserInput,
} from '@digisoft/shared';
import type { TokenType } from '@digisoft/db';
import { PrismaService } from '../prisma/prisma.service';
import { AppError } from '../common/errors/app-error';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';
import { AccessControlService } from './access-control.service';
import { MailerService } from '../email/mailer.service';
import { AppConfig } from '../config/config.module';
import { Workeasy360Settings } from '../workeasy360/workeasy360.settings';
import { provisionOrganization } from './organization-provisioning';

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

/** How a session was started; carried by every refresh token of its family. */
export type SessionMethod = 'PASSWORD' | 'WORKEASY360';

export interface SessionResult extends LoginResponse {
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

const PASSWORD_RESET_TTL_MINUTES = 60;
const EMAIL_VERIFICATION_TTL_HOURS = 48;
/** Upper bound on reset emails one request can trigger for a single address. */
const MAX_RESET_ACCOUNTS = 10;

/**
 * Platform-level module: it runs before a tenant context exists, so it uses the
 * unscoped Prisma client and passes `organizationId` explicitly on every query.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly accessControl: AccessControlService,
    private readonly mailer: MailerService,
    private readonly config: AppConfig,
    private readonly workeasy360: Workeasy360Settings,
  ) {}

  async register(input: RegisterInput, meta: RequestMeta): Promise<SessionResult> {
    const existingOrg = await this.prisma.organization.findUnique({
      where: { slug: input.organizationSlug },
      select: { id: true },
    });
    if (existingOrg) {
      throw AppError.conflict('That organization address is already taken');
    }

    const passwordHash = await this.passwords.hash(input.password);

    const { userId, organizationId } = await this.prisma.$transaction((tx) =>
      provisionOrganization(
        tx,
        { name: input.organizationName, slug: input.organizationSlug, timezone: input.timezone },
        {
          email: input.email,
          passwordHash,
          firstName: input.firstName,
          lastName: input.lastName,
        },
      ),
    );

    await this.sendEmailVerification(userId);
    return this.createSession(userId, organizationId, meta);
  }

  async login(input: LoginInput, meta: RequestMeta): Promise<SessionResult | OrganizationChoiceResponse> {
    const candidates = await this.prisma.user.findMany({
      where: {
        email: input.email,
        deletedAt: null,
        ...(input.organizationSlug
          ? { organization: { slug: input.organizationSlug, deletedAt: null } }
          : { organization: { deletedAt: null } }),
      },
      select: {
        id: true,
        organizationId: true,
        passwordHash: true,
        isActive: true,
        organization: { select: { name: true, slug: true } },
      },
    });

    // The same email can be a distinct account in more than one organization, each with
    // its own password — so which one the caller means isn't known until the password is
    // checked against each. Verifying every candidate (rather than stopping at the first)
    // also means a wrong password looks identical whether the email exists in zero, one
    // or five organizations — nothing here leaks membership to a guess.
    const verified: typeof candidates = [];
    for (const candidate of candidates) {
      if (await this.passwords.verify(candidate.passwordHash, input.password)) {
        verified.push(candidate);
      }
    }
    if (candidates.length === 0) {
      // Still pay the hashing cost so a nonexistent email takes the same time as a wrong
      // password against a real one.
      await this.passwords.verify(null, input.password);
    }

    if (verified.length === 0) {
      throw AppError.unauthenticated('Incorrect email address or password', 'INVALID_CREDENTIALS');
    }

    if (verified.length > 1) {
      if (input.organizationSlug) {
        // The slug already narrowed the query to one organization; more than one
        // verified match here would mean two active accounts for the same email in the
        // same org, which the unique constraint on (organizationId, email) prevents.
        throw AppError.unauthenticated('Incorrect email address or password', 'INVALID_CREDENTIALS');
      }
      return {
        status: 'choose_organization',
        organizations: verified
          .map((c) => ({ slug: c.organization.slug, name: c.organization.name }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      };
    }

    const candidate = verified[0]!;
    if (!candidate.isActive) {
      throw AppError.unauthenticated('This account has been deactivated', 'ACCOUNT_DISABLED');
    }

    await this.prisma.user.update({
      where: { id: candidate.id },
      data: { lastLoginAt: new Date() },
    });

    return this.createSession(candidate.id, candidate.organizationId, meta);
  }

  /**
   * `audience` pins the session to one organization and account type — the portal's
   * refresh endpoint only ever renews a customer session for its own help center.
   */
  async refresh(
    rawToken: string,
    meta: RequestMeta,
    audience?: { organizationId: string; type: 'AGENT' | 'CUSTOMER' },
  ): Promise<SessionResult> {
    const tokenHash = this.tokens.hashRefreshToken(rawToken);
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        userId: true,
        organizationId: true,
        familyId: true,
        authMethod: true,
        expiresAt: true,
        revokedAt: true,
      },
    });

    if (!stored) {
      throw AppError.unauthenticated('Invalid session', 'TOKEN_EXPIRED');
    }

    if (stored.revokedAt) {
      // Replay of a rotated token: assume theft and drop the whole family.
      await this.prisma.refreshToken.updateMany({
        where: { familyId: stored.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      this.logger.warn(
        `Refresh token replay detected for user ${stored.userId}; session family revoked`,
      );
      throw AppError.unauthenticated('Session is no longer valid', 'TOKEN_EXPIRED');
    }

    if (stored.expiresAt.getTime() <= Date.now()) {
      throw AppError.unauthenticated('Session has expired', 'TOKEN_EXPIRED');
    }

    if (audience) {
      const owner = await this.prisma.user.findUnique({
        where: { id: stored.userId },
        select: { type: true },
      });
      // Not revoked: the token is valid, just presented at the wrong door.
      if (stored.organizationId !== audience.organizationId || owner?.type !== audience.type) {
        throw AppError.unauthenticated('Invalid session', 'TOKEN_EXPIRED');
      }
    }

    if (!audience) {
      await this.assertAgentSessionMayRefresh(stored);
    }

    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });

    return this.createSession(
      stored.userId,
      stored.organizationId,
      meta,
      stored.familyId,
      stored.authMethod === 'WORKEASY360' ? 'WORKEASY360' : 'PASSWORD',
    );
  }

  /**
   * In SSO-only mode an agent session must have been started through Workeasy360, and in an
   * organization bound to Workeasy360 the user must have a Workeasy360 identity. Anything else
   * (a password-era family, an account never linked) is refused here, so a refresh cannot mint
   * tokens for a person who has to sign in with Workeasy360 first. Customers refresh through
   * the portal (which passes an audience) and are not affected.
   */
  private async assertAgentSessionMayRefresh(stored: {
    userId: string;
    organizationId: string;
    authMethod: string;
  }): Promise<void> {
    if (!this.workeasy360.ssoOnly) return;
    const user = await this.prisma.user.findFirst({
      where: { id: stored.userId, organizationId: stored.organizationId },
      select: {
        type: true,
        organization: { select: { workeasy360OrganizationId: true } },
        externalIdentities: { select: { id: true }, take: 1 },
      },
    });
    if (!user || user.type !== 'AGENT') return;
    const bound = user.organization.workeasy360OrganizationId !== null;
    const linked = user.externalIdentities.length > 0;
    if (stored.authMethod !== 'WORKEASY360' || (bound && !linked)) {
      throw new AppError(
        'WORKEASY360_SIGN_IN_REQUIRED',
        'Sign in with Workeasy360 to continue.',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  async logout(rawToken: string | undefined): Promise<void> {
    if (!rawToken) {
      return;
    }
    const tokenHash = this.tokens.hashRefreshToken(rawToken);
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      select: { familyId: true },
    });
    if (!stored) {
      return;
    }
    await this.prisma.refreshToken.updateMany({
      where: { familyId: stored.familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * `resetPath` lets the portal point a customer at its own reset page instead of the
   * agent one; everything else about the flow is identical.
   *
   * Without an organization slug the same address may be an account in several
   * organizations. Each gets its own reset email naming its organization — picking
   * one would strand the others, and asking the caller to choose would reveal which
   * organizations the address belongs to. The response is identical in every case.
   */
  async forgotPassword(
    input: ForgotPasswordInput,
    resetPath = '/reset-password',
    userType: 'AGENT' | 'CUSTOMER' = 'AGENT',
  ): Promise<void> {
    const users = await this.prisma.user.findMany({
      where: {
        email: input.email,
        type: userType,
        deletedAt: null,
        isActive: true,
        ...(input.organizationSlug
          ? { organization: { slug: input.organizationSlug, deletedAt: null } }
          : { organization: { deletedAt: null } }),
      },
      select: {
        id: true,
        firstName: true,
        email: true,
        organizationId: true,
        organization: { select: { name: true } },
      },
      orderBy: { createdAt: 'asc' },
      take: MAX_RESET_ACCOUNTS,
    });

    // Always succeed: the response must not reveal whether the address exists.
    for (const user of users) {
      const { raw, hash } = this.createOpaqueToken();
      await this.prisma.verificationToken.create({
        data: {
          userId: user.id,
          type: 'PASSWORD_RESET',
          tokenHash: hash,
          expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MINUTES * 60 * 1000),
        },
      });

      await this.mailer.send(user.organizationId, user.email, {
        kind: 'reset-password',
        firstName: user.firstName,
        url: `${this.mailer.frontendUrl}${resetPath}?token=${raw}`,
        expiresInMinutes: PASSWORD_RESET_TTL_MINUTES,
        ...(users.length > 1 ? { organizationName: user.organization.name } : {}),
      });
    }
  }

  /**
   * `scope` pins the reset to one kind of person in one organization (the help center's
   * reset page): only a PASSWORD_RESET token of a customer of that organization is accepted,
   * and anything else looks like an invalid link without being consumed.
   */
  async resetPassword(
    input: ResetPasswordInput,
    scope?: { organizationId: string; type: 'CUSTOMER' },
  ): Promise<void> {
    const record = await this.consumeToken(
      input.token,
      scope ? ['PASSWORD_RESET'] : ['PASSWORD_RESET', 'INVITE'],
    );
    if (scope && (record.user.organizationId !== scope.organizationId || record.user.type !== scope.type)) {
      throw AppError.validation('This link is invalid or has expired');
    }
    const passwordHash = await this.passwords.hash(input.password);
    const isInvite = record.type === 'INVITE';

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: record.userId },
        // Accepting an invite proves control of the mailbox, so it verifies the address.
        data: { passwordHash, ...(isInvite ? { emailVerifiedAt: new Date() } : {}) },
      }),
      this.prisma.verificationToken.update({
        where: { id: record.id },
        data: { usedAt: new Date() },
      }),
      // Password change invalidates every existing session.
      this.prisma.refreshToken.updateMany({
        where: { userId: record.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);

    await this.accessControl.invalidateUser(record.user.organizationId, record.userId);
    await this.mailer.send(record.user.organizationId, record.user.email, {
      kind: 'password-changed',
      firstName: record.user.firstName,
    });
  }

  async verifyEmail(token: string): Promise<void> {
    const record = await this.consumeToken(token, ['EMAIL_VERIFICATION']);
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: record.userId },
        data: { emailVerifiedAt: new Date() },
      }),
      this.prisma.verificationToken.update({
        where: { id: record.id },
        data: { usedAt: new Date() },
      }),
    ]);
  }

  async sendEmailVerification(userId: string, verifyPath = '/verify-email'): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        firstName: true,
        organizationId: true,
        emailVerifiedAt: true,
      },
    });
    if (!user || user.emailVerifiedAt) {
      return;
    }

    const { raw, hash } = this.createOpaqueToken();
    await this.prisma.verificationToken.create({
      data: {
        userId: user.id,
        type: 'EMAIL_VERIFICATION',
        tokenHash: hash,
        expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TTL_HOURS * 3600 * 1000),
      },
    });

    await this.mailer.send(user.organizationId, user.email, {
      kind: 'verify-email',
      firstName: user.firstName,
      url: `${this.mailer.frontendUrl}${verifyPath}?token=${raw}`,
    });
  }

  async changePassword(
    userId: string,
    organizationId: string,
    input: ChangePasswordInput,
  ): Promise<void> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, organizationId },
      select: { id: true, passwordHash: true, email: true, firstName: true },
    });
    if (!user) {
      throw AppError.notFound('user');
    }

    const matches = await this.passwords.verify(user.passwordHash, input.currentPassword);
    if (!matches) {
      throw AppError.unauthenticated('Current password is incorrect', 'INVALID_CREDENTIALS');
    }

    const passwordHash = await this.passwords.hash(input.newPassword);
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: user.id }, data: { passwordHash } }),
      this.prisma.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);

    await this.accessControl.invalidateUser(organizationId, user.id);
    await this.mailer.send(organizationId, user.email, {
      kind: 'password-changed',
      firstName: user.firstName,
    });
  }

  /**
   * Self-service profile edit. Only the caller's own presentational fields — never
   * email, roles, status or organization, which stay with user administration.
   */
  async updateProfile(actor: AuthenticatedUser, input: UpdateUserInput): Promise<AuthenticatedUser> {
    const { firstName, lastName, phone, avatarUrl } = input;
    await this.prisma.user.update({
      where: { id: actor.id, organizationId: actor.organizationId },
      data: { firstName, lastName, phone, avatarUrl },
    });
    await this.accessControl.invalidateUser(actor.organizationId, actor.id);
    return this.accessControl.resolveUser({
      sub: actor.id,
      org: actor.organizationId,
      email: actor.email,
      typ: actor.type,
    });
  }

  /** Issues the access token and the rotating refresh token for an existing user. */
  async createSession(
    userId: string,
    organizationId: string,
    meta: RequestMeta,
    familyId: string = randomUUID(),
    method: SessionMethod = 'PASSWORD',
  ): Promise<SessionResult> {
    const issuer = this.config.get('WORKEASY360_ISSUER');
    const user = await this.prisma.user.findFirst({
      where: { id: userId, organizationId },
      select: {
        id: true,
        email: true,
        type: true,
        organization: { select: { workeasy360OrganizationId: true } },
        externalIdentities: {
          where: issuer ? { issuer } : {},
          select: { subject: true },
          take: 1,
        },
      },
    });
    if (!user) {
      throw AppError.unauthenticated();
    }
    // Bound to Workeasy360: the claims carry what request-time entitlement checks need.
    const boundTo = user.organization.workeasy360OrganizationId;
    const subject = user.externalIdentities[0]?.subject;
    const w360 = boundTo ? { org: boundTo, ...(subject ? { sub: subject } : {}) } : undefined;

    const { token: refreshToken, tokenHash } = this.tokens.createRefreshToken();
    const refreshTokenExpiresAt = new Date(Date.now() + this.tokens.refreshTokenTtlMs);

    await this.prisma.refreshToken.create({
      data: {
        organizationId,
        userId,
        tokenHash,
        familyId,
        authMethod: method,
        expiresAt: refreshTokenExpiresAt,
        ip: meta.ip,
        userAgent: meta.userAgent,
      },
    });

    const accessToken = this.tokens.signAccessToken({
      sub: user.id,
      org: organizationId,
      email: user.email,
      typ: user.type,
      ...(w360 ? { w360 } : {}),
    });

    await this.accessControl.invalidateUser(organizationId, userId);
    const resolved = await this.accessControl.resolveUser({
      sub: user.id,
      org: organizationId,
      email: user.email,
      typ: user.type,
    });

    return {
      status: 'authenticated',
      accessToken,
      expiresIn: this.tokens.accessTokenTtlSeconds,
      user: resolved,
      refreshToken,
      refreshTokenExpiresAt,
    };
  }

  private createOpaqueToken(): { raw: string; hash: string } {
    const raw = randomBytes(32).toString('base64url');
    return { raw, hash: this.tokens.hashRefreshToken(raw) };
  }

  private async consumeToken(raw: string, types: TokenType[]) {
    const tokenHash = this.tokens.hashRefreshToken(raw);
    const record = await this.prisma.verificationToken.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        userId: true,
        type: true,
        expiresAt: true,
        usedAt: true,
        user: {
          select: { id: true, email: true, firstName: true, organizationId: true, type: true },
        },
      },
    });

    if (
      !record ||
      !types.includes(record.type) ||
      record.usedAt ||
      record.expiresAt.getTime() <= Date.now()
    ) {
      throw AppError.validation('This link is invalid or has expired');
    }
    return record;
  }
}
