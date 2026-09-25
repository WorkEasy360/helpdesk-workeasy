import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { TicketsModule } from '../tickets/tickets.module';
import { AttachmentsModule } from '../attachments/attachments.module';
import { attachmentMulterModule } from '../attachments/multer-options';
import { CommunityModule } from '../community/community.module';
import { PortalController } from './portal.controller';
import { PortalAuthController } from './portal-auth.controller';
import { PortalTicketsController } from './portal-tickets.controller';
import { PortalCommunityController } from './portal-community.controller';
import { PortalContentService } from './portal-content.service';
import { PortalAuthService } from './portal-auth.service';
import { PortalTicketsService } from './portal-tickets.service';
import { PortalContextMiddleware } from './portal-context.middleware';
import { PortalGuard } from './portal.guard';

@Module({
  // The portal's own upload route needs the same size limit as the agent one.
  imports: [TicketsModule, AttachmentsModule, CommunityModule, attachmentMulterModule()],
  controllers: [
    PortalAuthController,
    PortalTicketsController,
    PortalCommunityController,
    PortalController,
  ],
  providers: [PortalContentService, PortalAuthService, PortalTicketsService, PortalGuard],
})
export class PortalModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Resolves the help center and opens the tenant scope before the guard runs.
    consumer
      .apply(PortalContextMiddleware)
      .forRoutes(
        { path: 'portal/:slug', method: RequestMethod.ALL },
        { path: 'portal/:slug/*path', method: RequestMethod.ALL },
      );
  }
}
