import { Inject, Injectable } from '@nestjs/common';
import type { AuthenticatedUser, CreateRoleInput, UpdateRoleInput } from '@digisoft/shared';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import type { TenantPrismaClient } from '@digisoft/db';
import { PrismaService } from '../prisma/prisma.service';
import { AppError } from '../common/errors/app-error';
import { AuditService } from '../audit/audit.service';
import { AccessControlService } from '../auth/access-control.service';
import { assertCanGrantPermissions } from '../auth/role-grant';

const ROLE_FIELDS = {
  id: true,
  name: true,
  systemKey: true,
  description: true,
  isSystem: true,
  createdAt: true,
  updatedAt: true,
  permissions: { select: { permission: { select: { key: true } } } },
  _count: { select: { users: true } },
} as const;

@Injectable()
export class RolesService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly prisma: PrismaService,
    private readonly accessControl: AccessControlService,
    private readonly audit: AuditService,
  ) {}

  list() {
    return this.db.role.findMany({ select: ROLE_FIELDS, orderBy: { name: 'asc' } });
  }

  /** The permission catalogue is global and safe to expose to any authenticated agent. */
  listPermissions() {
    return this.prisma.permission.findMany({
      select: { key: true, resource: true, action: true, description: true },
      orderBy: [{ resource: 'asc' }, { action: 'asc' }],
    });
  }

  async findById(id: string) {
    const role = await this.db.role.findUnique({ where: { id }, select: ROLE_FIELDS });
    if (!role) {
      throw AppError.notFound('role');
    }
    return role;
  }

  async create(actor: AuthenticatedUser, input: CreateRoleInput) {
    assertCanGrantPermissions(actor, input.permissionKeys);
    const permissionIds = await this.resolvePermissionIds(input.permissionKeys);
    const role = await this.db.role.create({
      data: {
        organizationId: actor.organizationId,
        name: input.name,
        description: input.description ?? null,
        isSystem: false,
        permissions: { create: permissionIds.map((permissionId) => ({ permissionId })) },
      },
      select: ROLE_FIELDS,
    });
    await this.audit.record({
      organizationId: actor.organizationId,
      actorId: actor.id,
      action: 'role.created',
      entity: 'Role',
      entityId: role.id,
      newValue: role,
    });
    return role;
  }

  async update(id: string, actor: AuthenticatedUser, input: UpdateRoleInput) {
    const before = await this.findById(id);
    if (before.isSystem && input.permissionKeys) {
      throw AppError.validation('Permissions of a system role cannot be changed');
    }
    if (input.permissionKeys) {
      // Editing a role is granting to everyone who holds it, the caller included, so
      // both the permissions added and those removed must be within the caller's own.
      assertCanGrantPermissions(actor, [
        ...input.permissionKeys,
        ...before.permissions.map((link) => link.permission.key),
      ]);
    }

    const permissionIds = input.permissionKeys
      ? await this.resolvePermissionIds(input.permissionKeys)
      : null;

    const role = await this.db.$transaction(async (tx) => {
      if (permissionIds) {
        await tx.rolePermission.deleteMany({ where: { roleId: id } });
        await tx.rolePermission.createMany({
          data: permissionIds.map((permissionId) => ({ roleId: id, permissionId })),
        });
      }
      return tx.role.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
        },
        select: ROLE_FIELDS,
      });
    });

    await this.invalidateHolders(id, actor.organizationId);
    await this.audit.record({
      organizationId: actor.organizationId,
      actorId: actor.id,
      action: 'role.updated',
      entity: 'Role',
      entityId: id,
      oldValue: before,
      newValue: role,
    });
    return role;
  }

  async remove(id: string, actor: AuthenticatedUser): Promise<void> {
    const role = await this.findById(id);
    if (role.isSystem) {
      throw AppError.validation('System roles cannot be deleted');
    }
    if (role._count.users > 0) {
      throw AppError.conflict('Reassign the users holding this role before deleting it');
    }

    await this.db.role.delete({ where: { id } });
    await this.invalidateHolders(id, actor.organizationId);
    await this.audit.record({
      organizationId: actor.organizationId,
      actorId: actor.id,
      action: 'role.deleted',
      entity: 'Role',
      entityId: id,
    });
  }

  private async resolvePermissionIds(keys: string[]): Promise<string[]> {
    if (keys.length === 0) {
      return [];
    }
    const permissions = await this.prisma.permission.findMany({
      where: { key: { in: keys } },
      select: { id: true },
    });
    if (permissions.length !== new Set(keys).size) {
      throw AppError.validation('One or more permission keys are not recognised');
    }
    return permissions.map((p) => p.id);
  }

  private async invalidateHolders(roleId: string, organizationId: string): Promise<void> {
    const holders = await this.db.userRole.findMany({
      where: { roleId },
      select: { userId: true },
    });
    await this.accessControl.invalidateUsers(
      organizationId,
      holders.map((h) => h.userId),
    );
  }
}
