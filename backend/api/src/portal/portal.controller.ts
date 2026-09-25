import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  articleFeedbackSchema,
  kbSearchQuerySchema,
  paginationQuerySchema,
  webFormSubmissionSchema,
  type ArticleFeedbackInput,
  type AuthenticatedUser,
  type KbSearchQuery,
  type PaginationQuery,
  type WebFormSubmissionInput,
} from '@digisoft/shared';
import { Public } from '../common/decorators/public.decorator';
import { zodBody } from '../common/pipes/zod-validation.pipe';
import { AppError } from '../common/errors/app-error';
import { CurrentHelpCenter, PortalGuard, PortalUser } from './portal.guard';
import { PortalContentService } from './portal-content.service';
import type { PortalHelpCenter } from './portal.types';

/**
 * The customer-facing site. Routes are `@Public()` so the platform guard steps aside;
 * `PortalGuard` then applies the help center's own rules and resolves the visitor.
 */
@Public()
@UseGuards(PortalGuard)
@Controller('portal/:slug')
export class PortalController {
  constructor(private readonly content: PortalContentService) {}

  @Get()
  config(@CurrentHelpCenter() helpCenter: PortalHelpCenter) {
    return {
      slug: helpCenter.slug,
      name: helpCenter.name,
      tagline: helpCenter.tagline,
      welcomeMessage: helpCenter.welcomeMessage,
      logoUrl: helpCenter.logoUrl,
      primaryColor: helpCenter.primaryColor,
      supportEmail: helpCenter.supportEmail,
      footerText: helpCenter.footerText,
      allowSelfRegistration: helpCenter.allowSelfRegistration,
      allowTicketSubmission: helpCenter.allowTicketSubmission,
      kbEnabled: helpCenter.kbEnabled,
      communityEnabled: helpCenter.communityEnabled,
    };
  }

  @Get('kb/categories')
  categories(
    @CurrentHelpCenter() helpCenter: PortalHelpCenter,
    @PortalUser() user: AuthenticatedUser | null,
  ) {
    this.assertKb(helpCenter);
    return this.content.categories(user);
  }

  @Get('kb/articles')
  articles(
    @CurrentHelpCenter() helpCenter: PortalHelpCenter,
    @PortalUser() user: AuthenticatedUser | null,
    @Query(zodBody(paginationQuerySchema)) query: PaginationQuery,
    @Query('categoryId') categoryId?: string,
  ) {
    this.assertKb(helpCenter);
    return this.content.articles(user, { ...query, categoryId });
  }

  @Get('kb/search')
  search(
    @CurrentHelpCenter() helpCenter: PortalHelpCenter,
    @PortalUser() user: AuthenticatedUser | null,
    @Query(zodBody(kbSearchQuerySchema)) query: KbSearchQuery,
  ) {
    this.assertKb(helpCenter);
    return this.content.search(user, query);
  }

  /** `X-Metadata-Only: 1` reads the article without counting a view (page metadata). */
  @Get('kb/articles/:idOrSlug')
  article(
    @CurrentHelpCenter() helpCenter: PortalHelpCenter,
    @PortalUser() user: AuthenticatedUser | null,
    @Param('idOrSlug') idOrSlug: string,
    @Headers('x-metadata-only') metadataOnly: string | undefined,
  ) {
    this.assertKb(helpCenter);
    return this.content.article(user, idOrSlug, metadataOnly !== '1');
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @Post('kb/articles/:id/feedback')
  feedback(
    @CurrentHelpCenter() helpCenter: PortalHelpCenter,
    @PortalUser() user: AuthenticatedUser | null,
    @Param('id') id: string,
    @Body(zodBody(articleFeedbackSchema)) dto: ArticleFeedbackInput,
  ) {
    this.assertKb(helpCenter);
    return this.content.recordFeedback(user, id, dto);
  }

  @Get('forms')
  forms(@PortalUser() user: AuthenticatedUser | null) {
    return this.content.forms(user);
  }

  @Get('forms/:slug')
  form(@Param('slug') slug: string, @PortalUser() user: AuthenticatedUser | null) {
    return this.content.form(slug, user);
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('forms/:slug/submit')
  submit(
    @CurrentHelpCenter() helpCenter: PortalHelpCenter,
    @PortalUser() user: AuthenticatedUser | null,
    @Param('slug') slug: string,
    @Body(zodBody(webFormSubmissionSchema)) dto: WebFormSubmissionInput,
  ) {
    // A filled honeypot means a bot: answer as if it worked and store nothing.
    if (dto.website) {
      return Promise.resolve({ ticketId: null, ticketNumber: null, subject: null, successMessage: 'Thanks — we have received your request.' });
    }
    return this.content.submitForm(helpCenter, slug, user, dto.values);
  }

  private assertKb(helpCenter: PortalHelpCenter): void {
    if (!helpCenter.kbEnabled) {
      throw AppError.notFound('knowledge base');
    }
  }
}
