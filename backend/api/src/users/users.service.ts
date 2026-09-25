import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { Prisma } from '@digisoft/db';
import type {
  AuthenticatedUser,
  CreateUserInput,
  ListUsersQuery,
  UpdateUserInput,
} from '@digisoft/shared';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import type { TenantPrismaClient } from '@digisoft/db';
import { AppError } from '../common/errors/app-error';
import { AuditService } from '../audit/audit.service';
import { orderBy, pageMeta, toSkipTake } from '../common/dto/pagination';
import type { Paginated } from '../common/interceptors/response.interceptor';
import { PasswordService } from '../auth/password.service';
import { TokenService } from '../auth/token.service';
import { AccessControlService } from '../auth/access-control.service';
import { MailerService } from '../email/mailer.service';
import { assertCanGrantRoles } from '../auth/role-grant';

const SORTABLE = ['createdAt', 'updatedAt', 'firstName', 'lastName', 'email'] as const;
const INVITE_TTL_DAYS = 7;

const USER_FIELDS = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  phone: true,
  avatarUrl: true,
  type: true,
  isActive: true,
  emailVerifiedAt: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
  roles: { select: { role: { select: { id: true, name: true, systemKey: true } } } },
  departments: { select: { department: { select: { id: true, name: true } } } },
} as const;

@Injectable()
export class UsersService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly accessControl: AccessControlService,
    private readonly mailer: MailerService,
    private readonly audit: AuditService,
  ) {}

  async list(query: ListUsersQuery): Promise<Paginated<unknown>> {
    const where: Prisma.UserWhereInput = {
      type: 'AGENT',
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
      ...(query.departmentId ? { departments: { some: { departmentId: query.departmentId } } } : {}),
      ...(query.roleId ? { roles: { some: { roleId: query.roleId } } } : {}),
      ...(query.q
        ? {
            OR: [
              { firstName: { contains: query.q, mode: 'insensitive' } },
              { lastName: { contains: query.q, mode: 'insensitive' } },
              { email: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      this.db.user.findMany({
        where,
        select: USER_FIELDS,
        orderBy: orderBy(query.sort, SORTABLE, query.order, 'createdAt'),
        ...toSkipTake(query),
      }),
      this.db.user.count({ where }),
    ]);

    return { items, meta: pageMeta(query, total) };
  }

  async findById(id: string) {
    const user = await this.db.user.findUnique({ where: { id }, select: USER_FIELDS });
    if (!user) {
      throw AppError.notFound('user');
    }
    return user;
  }

  async create(actor: AuthenticatedUser, input: CreateUserInput) {
    await this.assertRolesGrantable(actor, input.roleIds);
    await this.assertDepartmentsExist(input.departmentIds);

    const existing = await this.db.user.findFirst({
      where: { email: input.email },
      select: { id: true },
    });
    if (existing) {
      throw AppError.conflict('A user with this email already exists', 'EMAIL_ALREADY_EXISTS');
    }

    const passwordHash = input.password ? await this.passwords.hash(input.password) : null;

    const user = await this.db.user.create({
      data: {
        organizationId: actor.organizationId,
        email: input.email,
        firstName: input.firstName,
        lastName: input.lastName,
        phone: input.phone ?? null,
        passwordHash,
        type: 'AGENT',
        roles: { create: input.roleIds.map((roleId) => ({ roleId })) },
        departments: {
          create: input.departmentIds.map((departmentId) => ({ departmentId })),
        },
      },
      select: USER_FIELDS,
    });

    await this.audit.record({
      organizationId: actor.organizationId,
      actorId: actor.id,
      action: 'user.created',
      entity: 'User',
      entityId: user.id,
      newValue: { email: user.email, roleIds: input.roleIds },
    });

    if (!passwordHash) {
      await this.sendInvite(actor.organizationId, user.id);
    }
    return user;
  }

  async update(id: string, actor: AuthenticatedUser, input: UpdateUserInput) {
    const before = await this.findById(id);
    const user = await this.db.user.update({
      where: { id },
      data: input,
      select: USER_FIELDS,
    });
    // GET /auth/me serves the cached identity; drop it so the new name shows at once.
    await this.accessControl.invalidateUser(actor.organizationId, id);
    await this.audit.record({
      organizationId: actor.organizationId,
      actorId: actor.id,
      action: 'user.updated',
      entity: 'User',
      entityId: id,
      oldValue: before,
      newValue: user,
    });
    return user;
  }

  async setRoles(id: string, actor: AuthenticatedUser, roleIds: string[]) {
    await this.findById(id);
    // Both sides: the new roles must be within the caller's own access, and so must the
    // roles being taken away — an Admin cannot demote the Super Admin.
    await this.assertCanManage(actor, id);
    await this.assertRolesGrantable(actor, roleIds);

    await this.db.$transaction(async (tx) => {
      await tx.userRole.deleteMany({ where: { userId: id } });
      await tx.userRole.createMany({ data: roleIds.map((roleId) => ({ userId: id, roleId })) });
    });

    await this.accessControl.invalidateUser(actor.organizationId, id);
    await this.audit.record({
      organizationId: actor.organizationId,
      actorId: actor.id,
      action: 'user.roles_changed',
      entity: 'User',
      entityId: id,
      newValue: { roleIds },
    });
    return this.findById(id);
  }

  async setDepartments(id: string, actor: AuthenticatedUser, departmentIds: string[]) {
    await this.findById(id);
    await this.assertDepartmentsExist(departmentIds);

    await this.db.$transaction(async (tx) => {
      await tx.userDepartment.deleteMany({ where: { userId: id } });
      if (departmentIds.length > 0) {
        await tx.userDepartment.createMany({
          data: departmentIds.map((departmentId) => ({ userId: id, departmentId })),
        });
      }
    });

    // Department membership decides which tickets the user may read, so the cached
    // access scope has to go with it.
    await this.accessControl.invalidateUser(actor.organizationId, id);
    await this.audit.record({
      organizationId: actor.organizationId,
      actorId: actor.id,
      action: 'user.departments_changed',
      entity: 'User',
      entityId: id,
      newValue: { departmentIds },
    });
    return this.findById(id);
  }

  async setActive(id: string, actor: AuthenticatedUser, isActive: boolean) {
    await this.findById(id);
    if (id === actor.id && !isActive) {
      throw AppError.validation('You cannot deactivate your own account');
    }
    await this.assertCanManage(actor, id);

    const user = await this.db.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id },
        data: { isActive },
        select: USER_FIELDS,
      });
      if (!isActive) {
        await tx.refreshToken.updateMany({
          where: { userId: id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }
      return updated;
    });

    await this.accessControl.invalidateUser(actor.organizationId, id);
    await this.audit.record({
      organizationId: actor.organizationId,
      actorId: actor.id,
      action: isActive ? 'user.activated' : 'user.deactivated',
      entity: 'User',
      entityId: id,
    });
    return user;
  }

  async remove(id: string, actor: AuthenticatedUser): Promise<void> {
    if (id === actor.id) {
      throw AppError.validation('You cannot delete your own account');
    }
    await this.findById(id);
    await this.assertCanManage(actor, id);

    await this.db.$transaction(async (tx) => {
      await tx.user.update({
        where: { id },
        data: { deletedAt: new Date(), isActive: false },
      });
      await tx.refreshToken.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });

    await this.accessControl.invalidateUser(actor.organizationId, id);
    await this.audit.record({
      organizationId: actor.organizationId,
      actorId: actor.id,
      action: 'user.deleted',
      entity: 'User',
      entityId: id,
    });
  }

  /** Issues an invite link so a user created without a password can set their own. */
  async sendInvite(organizationId: string, userId: string): Promise<void> {
    const user = await this.db.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        firstName: true,
        organization: { select: { name: true } },
      },
    });
    if (!user) {
      throw AppError.notFound('user');
    }

    const raw = randomBytes(32).toString('base64url');
    await this.db.verificationToken.create({
      data: {
        userId: user.id,
        type: 'INVITE',
        tokenHash: this.tokens.hashRefreshToken(raw),
        expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 24 * 3600 * 1000),
      },
    });

    await this.mailer.send(organizationId, user.email, {
      kind: 'invite',
      firstName: user.firstName,
      organizationName: user.organization.name,
      url: `${this.mailer.frontendUrl}/reset-password?token=${raw}&invite=1`,
    });
  }

  private async assertRolesGrantable(actor: AuthenticatedUser, roleIds: string[]): Promise<void> {
    const roles = await this.db.role.findMany({
      where: { id: { in: roleIds } },
      select: { name: true, permissions: { select: { permission: { select: { key: true } } } } },
    });
    if (roles.length !== new Set(roleIds).size) {
      throw AppError.validation('One or more roles do not exist in this organization');
    }
    assertCanGrantRoles(actor, roles);
  }

  /** A user whose roles carry access the caller lacks can only be managed from above. */
  private async assertCanManage(actor: AuthenticatedUser, userId: string): Promise<void> {
    const links = await this.db.userRole.findMany({
      where: { userId },
      select: {
        role: {
          select: { name: true, permissions: { select: { permission: { select: { key: true } } } } },
        },
      },
    });
    assertCanGrantRoles(
      actor,
      links.map((link) => link.role),
    );
  }

  private async assertDepartmentsExist(departmentIds: string[]): Promise<void> {
    if (departmentIds.length === 0) {
      return;
    }
    const found = await this.db.department.count({ where: { id: { in: departmentIds } } });
    if (found !== new Set(departmentIds).size) {
      throw AppError.validation('One or more departments do not exist in this organization');
    }
  }
}
