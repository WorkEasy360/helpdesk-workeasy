import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import type { TenantPrismaClient } from '@digisoft/db';
import type { ApiKeyInput, AuthenticatedUser } from '@digisoft/shared';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { AppError } from '../common/errors/app-error';
import { AuditService } from '../audit/audit.service';
import { assertCanGrantRoles } from '../auth/role-grant';

const KEY_SELECT = {
  id: true,
  name: true,
  prefix: true,
  userId: true,
  lastUsedAt: true,
  expiresAt: true,
  revokedAt: true,
  createdAt: true,
  role: { select: { id: true, name: true, systemKey: true } },
  createdBy: { select: { id: true, firstName: true, lastName: true } },
} as const;

/** Only the hash is stored, so a leaked database cannot be used to call the API. */
export function hashApiKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

@Injectable()
export class ApiKeysService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly audit: AuditService,
  ) {}

  list() {
    return this.db.apiKey.findMany({ select: KEY_SELECT, orderBy: { createdAt: 'desc' } });
  }

  async create(actor: AuthenticatedUser, input: ApiKeyInput) {
    const role = await this.db.role.findFirst({
      where: { id: input.roleId },
      select: {
        id: true,
        name: true,
        permissions: { select: { permission: { select: { key: true } } } },
      },
    });
    if (!role) {
      throw AppError.validation('The selected role does not exist');
    }
    // A key acts with its role's permissions; it must not outrank whoever created it.
    assertCanGrantRoles(actor, [role]);

    // `dsk_<random>`: the prefix is stored so a key can be recognised in a list.
    const secret = randomBytes(24).toString('base64url');
    const raw = `dsk_${secret}`;

    // Every key gets its own service user holding the chosen role, so calls made with
    // it are authorised, attributed and audited like any other actor.
    const key = await this.db.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          organizationId: actor.organizationId,
          email: `api-${raw.slice(4, 14).toLowerCase()}@api-key.local`,
          firstName: input.name.slice(0, 80),
          lastName: 'API key',
          type: 'AGENT',
          // No password: this identity can only ever be used with the key itself.
          passwordHash: null,
          roles: { create: { roleId: role.id } },
        },
        select: { id: true },
      });

      return tx.apiKey.create({
        data: {
          organizationId: actor.organizationId,
          name: input.name,
          prefix: raw.slice(0, 12),
          keyHash: hashApiKey(raw),
          roleId: role.id,
          userId: user.id,
          createdById: actor.id,
          expiresAt: input.expiresAt ?? null,
        },
        select: KEY_SELECT,
      });
    });

    await this.audit.record({
      organizationId: actor.organizationId,
      actorId: actor.id,
      action: 'api_key.created',
      entity: 'ApiKey',
      entityId: key.id,
      newValue: { name: key.name, role: role.name },
    });

    // The only time the key is ever returned.
    return { ...key, key: raw };
  }

  async revoke(id: string, actor: AuthenticatedUser) {
    const existing = await this.db.apiKey.findFirst({
      where: { id },
      select: { id: true, name: true, revokedAt: true, userId: true },
    });
    if (!existing) {
      throw AppError.notFound('api key');
    }
    if (existing.revokedAt) {
      return { revoked: true };
    }

    await this.db.$transaction([
      this.db.apiKey.update({ where: { id }, data: { revokedAt: new Date() } }),
      // Deactivating the service user closes every path the key could still take.
      this.db.user.update({ where: { id: existing.userId }, data: { isActive: false } }),
    ]);
    await this.audit.record({
      organizationId: actor.organizationId,
      actorId: actor.id,
      action: 'api_key.revoked',
      entity: 'ApiKey',
      entityId: id,
      oldValue: { name: existing.name },
    });
    return { revoked: true };
  }
}
