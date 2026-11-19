import { Injectable } from '@nestjs/common';
import {
  SYSTEM_ROLES,
  type PortalLoginInput,
  type PortalRegisterInput,
  type ResetPasswordInput,
} from '@digisoft/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AppError } from '../common/errors/app-error';
import { AuthService, type RequestMeta, type SessionResult } from '../auth/auth.service';
import { PasswordService } from '../auth/password.service';
import type { PortalHelpCenter } from './portal.types';

/**
 * Customer accounts for the help center. A portal visitor is a `User` of type
 * CUSTOMER linked to the `Contact` their tickets hang off, so the session, refresh
 * rotation and password rules are exactly the ones the agent side already uses —
 * there is no second, weaker authentication path in the product.
 *
 * Platform-level, like the agent auth service: it runs before a tenant scope exists
 * and always passes `organizationId` explicitly.
 */
@Injectable()
export class PortalAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly passwords: PasswordService,
  ) {}

  async register(
    helpCenter: PortalHelpCenter,
    input: PortalRegisterInput,
    meta: RequestMeta,
  ): Promise<SessionResult> {
    if (!helpCenter.allowSelfRegistration) {
      throw AppError.forbidden('This help center does not accept new accounts');
    }

    const existingUser = await this.prisma.user.findFirst({
      where: { organizationId: helpCenter.organizationId, email: input.email, deletedAt: null },
      select: { id: true },
    });
    if (existingUser) {
      // Deliberately explicit: the sign-up form needs to be able to say "sign in instead".
      throw AppError.conflict('An account already exists for that email address');
    }

    const passwordHash = await this.passwords.hash(input.password);
    const role = await this.prisma.role.findFirst({
      where: { organizationId: helpCenter.organizationId, systemKey: SYSTEM_ROLES.CUSTOMER },
      select: { id: true },
    });

    const userId = await this.prisma.$transaction(async (tx) => {
      // An agent may already have a contact for this person; reuse it so their existing
      // tickets show up the first time they sign in.
      const contact = await tx.contact.findFirst({
        where: {
          organizationId: helpCenter.organizationId,
          email: input.email,
          deletedAt: null,
        },
        select: { id: true, portalUser: { select: { id: true } } },
      });

      if (contact?.portalUser) {
        throw AppError.conflict('An account already exists for that email address');
      }

      const contactId =
        contact?.id ??
        (
          await tx.contact.create({
            data: {
              organizationId: helpCenter.organizationId,
              firstName: input.firstName,
              lastName: input.lastName ?? null,
              email: input.email,
            },
            select: { id: true },
          })
        ).id;

      const user = await tx.user.create({
        data: {
          organizationId: helpCenter.organizationId,
          email: input.email,
          passwordHash,
          firstName: input.firstName,
          lastName: input.lastName ?? '',
          type: 'CUSTOMER',
          contactId,
          ...(role ? { roles: { create: { roleId: role.id } } } : {}),
        },
        select: { id: true },
      });
      return user.id;
    });

    await this.auth.sendEmailVerification(userId, `/help/${helpCenter.slug}/verify-email`);
    return this.auth.createSession(userId, helpCenter.organizationId, meta);
  }

  async login(
    helpCenter: PortalHelpCenter,
    input: PortalLoginInput,
    meta: RequestMeta,
  ): Promise<SessionResult> {
    const user = await this.prisma.user.findFirst({
      where: {
        organizationId: helpCenter.organizationId,
        email: input.email,
        type: 'CUSTOMER',
        deletedAt: null,
      },
      select: { id: true, passwordHash: true, isActive: true },
    });

    // Always verify, so a missing account costs the same as a wrong password.
    const matches = await this.passwords.verify(user?.passwordHash ?? null, input.password);
    if (!user || !matches) {
      throw AppError.unauthenticated('Incorrect email address or password', 'INVALID_CREDENTIALS');
    }
    if (!user.isActive) {
      throw AppError.unauthenticated('This account has been deactivated', 'ACCOUNT_DISABLED');
    }

    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    return this.auth.createSession(user.id, helpCenter.organizationId, meta);
  }

  /**
   * Reset links point back at the help center the customer used, not the agent app, and
   * the lookup is pinned to this organization so an address reused in another tenant
   * cannot be targeted from here.
   */
  async forgotPassword(helpCenter: PortalHelpCenter, email: string): Promise<void> {
    const organization = await this.prisma.organization.findUnique({
      where: { id: helpCenter.organizationId },
      select: { slug: true },
    });
    await this.auth.forgotPassword(
      { email, organizationSlug: organization?.slug },
      `/help/${helpCenter.slug}/reset-password`,
      // Only customers: an agent with this address gets nothing from a help center.
      'CUSTOMER',
    );
  }

  /** A customer of this help center sets a new password with the token from their reset email. */
  async resetPassword(helpCenter: PortalHelpCenter, input: ResetPasswordInput): Promise<void> {
    await this.auth.resetPassword(input, { organizationId: helpCenter.organizationId, type: 'CUSTOMER' });
  }

  async profile(organizationId: string, userId: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, organizationId },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        emailVerifiedAt: true,
        contact: {
          select: {
            id: true,
            phone: true,
            account: { select: { id: true, name: true } },
          },
        },
      },
    });
    if (!user) {
      throw AppError.notFound('account');
    }
    return user;
  }
}
