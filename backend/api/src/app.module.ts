import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { AppConfig, AppConfigModule } from './config/config.module';
import { PrismaModule } from './prisma/prisma.module';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT, RedisModule } from './redis/redis.module';
import { QueueModule } from './queue/queue.module';
import { EmailModule } from './email/email.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { RealtimeModule } from './realtime/realtime.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { UsersModule } from './users/users.module';
import { RolesModule } from './roles/roles.module';
import { DepartmentsModule } from './departments/departments.module';
import { ContactsModule } from './contacts/contacts.module';
import { StorageModule } from './storage/storage.module';
import { TicketConfigModule } from './ticket-config/ticket-config.module';
import { TicketsModule } from './tickets/tickets.module';
import { AttachmentsModule } from './attachments/attachments.module';
import { EngineModule } from './engine/engine.module';
import { ActivitiesModule } from './activities/activities.module';
import { OperationsModule } from './operations/operations.module';
import { KbModule } from './kb/kb.module';
import { HelpCenterModule } from './help-center/help-center.module';
import { CommunityModule } from './community/community.module';
import { PortalModule } from './portal/portal.module';
import { ChannelsModule } from './channels/channels.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { ChatModule } from './chat/chat.module';
import { AiModule } from './ai/ai.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { AiDispatchModule } from './ai/ai-dispatch.module';
import { ChannelOutboundModule } from './channels/channel-outbound.module';
import { AccountsModule } from './accounts/accounts.module';
import { NotificationsModule } from './notifications/notifications.module';
import { HealthModule } from './health/health.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { PermissionsGuard } from './common/guards/permissions.guard';
import { TenantContextMiddleware } from './common/middleware/tenant-context.middleware';
import { PermissionCatalogueService } from './bootstrap/permission-catalogue.service';
import { buildThrottlerOptions } from './common/throttler/throttler.options';
import { RedisThrottlerStorage } from './common/throttler/redis-throttler.storage';

@Module({
  imports: [
    AppConfigModule,
    LoggerModule.forRootAsync({
      inject: [AppConfig],
      useFactory: (config: AppConfig) => ({
        pinoHttp: {
          level: config.get('LOG_LEVEL'),
          transport: config.isProduction ? undefined : { target: 'pino-pretty' },
          // Credentials must never reach the log stream.
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              'res.headers["set-cookie"]',
              'req.body.password',
              'req.body.currentPassword',
              'req.body.newPassword',
              'req.body.token',
            ],
            remove: true,
          },
        },
      }),
    }),
    // Imported ahead of the throttler so the Redis client is available to its storage.
    RedisModule,
    ThrottlerModule.forRootAsync({
      inject: [AppConfig, REDIS_CLIENT],
      useFactory: (config: AppConfig, redis: Redis) =>
        buildThrottlerOptions(
          {
            enabled: config.get('THROTTLE_ENABLED'),
            ttlSeconds: config.get('THROTTLE_TTL_SECONDS'),
            limit: config.get('THROTTLE_LIMIT'),
            authLimit: config.get('AUTH_THROTTLE_LIMIT'),
          },
          // Shared counters: limits hold across every API instance, not per process.
          new RedisThrottlerStorage(redis),
        ),
    }),
    PrismaModule,
    QueueModule,
    EmailModule,
    AuditModule,
    AuthModule,
    RealtimeModule,
    OrganizationsModule,
    UsersModule,
    RolesModule,
    DepartmentsModule,
    ContactsModule,
    AccountsModule,
    StorageModule,
    TicketConfigModule,
    EngineModule,
    TicketsModule,
    AttachmentsModule,
    ActivitiesModule,
    OperationsModule,
    KbModule,
    HelpCenterModule,
    CommunityModule,
    PortalModule,
    ChannelOutboundModule,
    ChannelsModule,
    IntegrationsModule,
    ChatModule,
    AiDispatchModule,
    AiModule,
    AnalyticsModule,
    NotificationsModule,
    HealthModule,
  ],
  providers: [
    PermissionCatalogueService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
    {
      provide: APP_FILTER,
      inject: [AppConfig],
      useFactory: (config: AppConfig) => new AllExceptionsFilter(config.isProduction),
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Runs ahead of the guards so the tenant scope wraps the whole request.
    consumer.apply(TenantContextMiddleware).forRoutes('*');
  }
}
