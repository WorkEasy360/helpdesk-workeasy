import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@digisoft/db';

/**
 * Raw, unscoped client. Inject this only in platform-level code (auth lookup by
 * email, organization provisioning, health checks). Everything else must inject
 * TENANT_PRISMA so tenant isolation is enforced.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    // Interactive transactions (organization provisioning, ticket creation) run many
    // sequential queries; against a distant database each one costs a full round trip,
    // so Prisma's 5s default aborts them. Validated in env.schema.ts.
    super({
      transactionOptions: {
        timeout: Number(process.env.DB_TRANSACTION_TIMEOUT_MS ?? 30_000),
        maxWait: Number(process.env.DB_TRANSACTION_MAX_WAIT_MS ?? 10_000),
      },
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Database connection established');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
