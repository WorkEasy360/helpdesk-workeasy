import { Prisma, PrismaClient } from '@prisma/client';
import { MissingTenantContextError, TenantContext, type TenantStore } from './tenant-context';

/**
 * Models that carry `organizationId` directly. Join tables (UserRole, TeamMember,
 * ...) are reached only through a parent row whose ownership the owning service
 * verifies first, and `Permission` is a global catalogue by design.
 */
export const TENANT_MODELS: ReadonlySet<string> = new Set([
  'BusinessHours',
  'Holiday',
  'User',
  'Role',
  'Department',
  'Team',
  'Account',
  'Contact',
  'RefreshToken',
  'Notification',
  'AuditLog',
  'TicketStatus',
  'TicketPriority',
  'TicketCategory',
  'Tag',
  'Ticket',
  'TicketMessage',
  'Attachment',
  'TicketLink',
  'Activity',
  'AssignmentRule',
  'AutomationRule',
  'AutomationRun',
  'SlaPolicy',
  'Blueprint',
  'HelpCenter',
  'KbCategory',
  'KbArticle',
  'KbArticleFeedback',
  'WebForm',
  'CommunityCategory',
  'CommunityTopic',
  'CommunityReply',
  'CommunityVote',
  'Channel',
  'ChannelIdentity',
  'ChannelEvent',
  'ChatSession',
  'WebhookEndpoint',
  'WebhookDelivery',
  'ApiKey',
  'AiSettings',
  'AiInsight',
  'AiUsageDay',
  'CsatSettings',
  'CsatResponse',
  'ReportDefinition',
  'ReportExport',
  'TicketDailyMetric',
  'AgentDailyMetric',
]);

/** Models with a `deletedAt` column that should be hidden from ordinary reads. */
export const SOFT_DELETE_MODELS: ReadonlySet<string> = new Set([
  'Organization',
  'User',
  'Department',
  'Team',
  'Account',
  'Contact',
  'TicketCategory',
  'Ticket',
  'TicketMessage',
  'Activity',
  'KbCategory',
  'KbArticle',
  'WebForm',
  'CommunityCategory',
  'CommunityTopic',
  'CommunityReply',
  'Channel',
  'WebhookEndpoint',
]);

const WHERE_OPERATIONS = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'findUnique',
  'findUniqueOrThrow',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
  'count',
  'aggregate',
  'groupBy',
  'upsert',
]);

const READ_OPERATIONS = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'findUnique',
  'findUniqueOrThrow',
  'count',
  'aggregate',
  'groupBy',
]);

type AnyArgs = Record<string, unknown>;

function withOrganization(where: unknown, organizationId: string): AnyArgs {
  return { ...((where as AnyArgs) ?? {}), organizationId };
}

/**
 * Injects `organizationId` into every query against a tenant-owned model and hides
 * soft-deleted rows. Cross-tenant reads return null/empty and cross-tenant writes
 * raise Prisma's P2025, which the exception filter maps to 404 — so record ids are
 * never enumerable across organizations.
 */
/**
 * Pure argument rewriter behind the extension: given the model, operation and the
 * caller's tenant store, returns the arguments Prisma should actually run. Exported
 * so the isolation rules can be unit tested without a database.
 */
export function scopeArgs(
  model: string,
  operation: string,
  args: unknown,
  store: TenantStore | undefined,
): AnyArgs {
  const next: AnyArgs = { ...((args as AnyArgs) ?? {}) };

  if (store?.bypass) {
    return next;
  }

  if (TENANT_MODELS.has(model)) {
    const organizationId = store?.organizationId;
    if (!organizationId) {
      throw new MissingTenantContextError(model, operation);
    }

    if (WHERE_OPERATIONS.has(operation)) {
      next['where'] = withOrganization(next['where'], organizationId);
    }

    if (operation === 'create') {
      next['data'] = { ...((next['data'] as AnyArgs) ?? {}), organizationId };
    } else if (operation === 'upsert') {
      next['create'] = { ...((next['create'] as AnyArgs) ?? {}), organizationId };
    } else if (operation === 'createMany' || operation === 'createManyAndReturn') {
      const data = next['data'];
      next['data'] = Array.isArray(data)
        ? data.map((row) => ({ ...(row as AnyArgs), organizationId }))
        : { ...((data as AnyArgs) ?? {}), organizationId };
    }
  }

  // Hide soft-deleted rows from ordinary reads unless the caller asked for them.
  if (SOFT_DELETE_MODELS.has(model) && READ_OPERATIONS.has(operation)) {
    const where = (next['where'] as AnyArgs) ?? {};
    if (!('deletedAt' in where)) {
      next['where'] = { ...where, deletedAt: null };
    }
  }

  return next;
}

export function applyTenantScope(client: PrismaClient) {
  return client.$extends({
    name: 'tenant-isolation',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const next = scopeArgs(model, operation, args, TenantContext.store);
          return query(next as typeof args);
        },
      },
    },
  });
}

export type TenantPrismaClient = ReturnType<typeof applyTenantScope>;
export type TenantTransactionClient = Omit<
  TenantPrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

export const PRISMA_KNOWN_ERRORS = Prisma.PrismaClientKnownRequestError;
