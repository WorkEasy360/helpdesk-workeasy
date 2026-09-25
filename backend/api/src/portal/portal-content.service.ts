import { Inject, Injectable } from '@nestjs/common';
import { TenantContext, type Prisma, type TenantPrismaClient } from '@digisoft/db';
import {
  webFormFieldListSchema,
  type ArticleFeedbackInput,
  type AuthenticatedUser,
  type ContentVisibility,
  type KbSearchQuery,
  type PaginationQuery,
  type WebFormField,
} from '@digisoft/shared';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { AppError } from '../common/errors/app-error';
import { pageMeta, toSkipTake } from '../common/dto/pagination';
import type { Paginated } from '../common/interceptors/response.interceptor';
import { TicketsService } from '../tickets/tickets.service';
import type { PortalHelpCenter } from './portal.types';
import { readSubmission, type SubmissionResult } from './web-form-submission';

const ARTICLE_CARD_SELECT = {
  id: true,
  title: true,
  slug: true,
  summary: true,
  publishedAt: true,
  viewCount: true,
  helpfulCount: true,
  notHelpfulCount: true,
  category: { select: { id: true, name: true, slug: true } },
} as const;

const ARTICLE_DETAIL_SELECT = {
  ...ARTICLE_CARD_SELECT,
  body: true,
  keywords: true,
  seoTitle: true,
  seoDescription: true,
  updatedAt: true,
} as const;

const FORM_SELECT = {
  id: true,
  name: true,
  slug: true,
  description: true,
  fields: true,
  submitLabel: true,
  successMessage: true,
  requireLogin: true,
} as const;

/** What a visitor is allowed to read. Anonymous visitors see public content only. */
export function visibleTo(viewer: AuthenticatedUser | null): ContentVisibility[] {
  if (viewer?.type === 'AGENT') {
    return ['PUBLIC', 'PORTAL_USERS', 'AGENTS_ONLY'];
  }
  return viewer ? ['PUBLIC', 'PORTAL_USERS'] : ['PUBLIC'];
}


/**
 * Everything the customer-facing site reads or writes that is not a ticket: knowledge
 * base content, article feedback and web forms. Runs inside the tenant scope the portal
 * middleware opened, so an organization can only ever reach its own rows.
 */
@Injectable()
export class PortalContentService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly tickets: TicketsService,
  ) {}

  categories(viewer: AuthenticatedUser | null) {
    return this.db.kbCategory.findMany({
      where: { isActive: true, visibility: { in: visibleTo(viewer) } },
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        icon: true,
        parentId: true,
        position: true,
        _count: {
          select: {
            articles: {
              where: { status: 'PUBLISHED', visibility: { in: visibleTo(viewer) }, deletedAt: null },
            },
          },
        },
      },
      orderBy: [{ position: 'asc' }, { name: 'asc' }],
    });
  }

  async articles(
    viewer: AuthenticatedUser | null,
    query: PaginationQuery & { categoryId?: string },
  ): Promise<Paginated<unknown>> {
    const where = this.articleFilter(viewer, query.categoryId);
    const [items, total] = await Promise.all([
      this.db.kbArticle.findMany({
        where,
        select: ARTICLE_CARD_SELECT,
        orderBy: [{ position: 'asc' }, { publishedAt: 'desc' }],
        ...toSkipTake(query),
      }),
      this.db.kbArticle.count({ where }),
    ]);
    return { items, meta: pageMeta(query, total) };
  }

  /**
   * Article page: the article, its neighbours, and a view counted once per request —
   * unless `countView` is off, for the server-side fetch that only builds page metadata.
   */
  async article(viewer: AuthenticatedUser | null, idOrSlug: string, countView = true) {
    const article = await this.db.kbArticle.findFirst({
      where: { AND: [this.articleFilter(viewer), { OR: [{ id: idOrSlug }, { slug: idOrSlug }] }] },
      select: ARTICLE_DETAIL_SELECT,
    });
    if (!article) {
      throw AppError.notFound('article');
    }

    if (countView) {
      await this.db.kbArticle.update({
        where: { id: article.id },
        data: { viewCount: { increment: 1 } },
      });
    }

    const related = article.category
      ? await this.db.kbArticle.findMany({
          where: {
            AND: [
              this.articleFilter(viewer, article.category.id),
              { id: { not: article.id } },
            ],
          },
          select: ARTICLE_CARD_SELECT,
          orderBy: { viewCount: 'desc' },
          take: 5,
        })
      : [];

    const myFeedback = viewer
      ? await this.db.kbArticleFeedback.findFirst({
          where: { articleId: article.id, userId: viewer.id },
          select: { isHelpful: true },
        })
      : null;

    return { ...article, related, myFeedback };
  }

  /**
   * Title matches rank above body matches — the ordering a reader expects — without
   * needing a search engine in front of PostgreSQL.
   */
  async search(viewer: AuthenticatedUser | null, query: KbSearchQuery) {
    const base = this.articleFilter(viewer, query.categoryId);
    const term = query.q;

    const [titleHits, bodyHits] = await Promise.all([
      this.db.kbArticle.findMany({
        where: {
          AND: [
            base,
            {
              OR: [
                { title: { contains: term, mode: 'insensitive' } },
                { keywords: { has: term.toLowerCase() } },
              ],
            },
          ],
        },
        select: ARTICLE_CARD_SELECT,
        orderBy: { viewCount: 'desc' },
        take: query.limit,
      }),
      this.db.kbArticle.findMany({
        where: {
          AND: [
            base,
            {
              OR: [
                { summary: { contains: term, mode: 'insensitive' } },
                { body: { contains: term, mode: 'insensitive' } },
              ],
            },
          ],
        },
        select: ARTICLE_CARD_SELECT,
        orderBy: { viewCount: 'desc' },
        take: query.limit,
      }),
    ]);

    const seen = new Set<string>();
    const results = [];
    for (const article of [...titleHits, ...bodyHits]) {
      if (seen.has(article.id)) {
        continue;
      }
      seen.add(article.id);
      results.push(article);
      if (results.length >= query.limit) {
        break;
      }
    }
    return results;
  }

  /** "Was this helpful?" — one vote per signed-in reader, changeable. */
  async recordFeedback(
    viewer: AuthenticatedUser | null,
    articleId: string,
    input: ArticleFeedbackInput,
  ) {
    const article = await this.db.kbArticle.findFirst({
      where: this.articleFilter(viewer, undefined, articleId),
      select: { id: true },
    });
    if (!article) {
      throw AppError.notFound('article');
    }

    const previous = viewer
      ? await this.db.kbArticleFeedback.findFirst({
          where: { articleId: article.id, userId: viewer.id },
          select: { id: true, isHelpful: true },
        })
      : null;

    if (previous && previous.isHelpful === input.isHelpful) {
      return this.counters(article.id);
    }

    await this.db.$transaction(async (tx) => {
      if (previous) {
        await tx.kbArticleFeedback.update({
          where: { id: previous.id },
          data: { isHelpful: input.isHelpful, comment: input.comment ?? null },
        });
        // Switching a vote moves it from one counter to the other.
        await tx.kbArticle.update({
          where: { id: article.id },
          data: {
            helpfulCount: { increment: input.isHelpful ? 1 : -1 },
            notHelpfulCount: { increment: input.isHelpful ? -1 : 1 },
          },
        });
        return;
      }

      await tx.kbArticleFeedback.create({
        data: {
          organizationId: TenantContext.requireOrganizationId(),
          articleId: article.id,
          userId: viewer?.id ?? null,
          isHelpful: input.isHelpful,
          comment: input.comment ?? null,
        },
      });
      await tx.kbArticle.update({
        where: { id: article.id },
        data: input.isHelpful
          ? { helpfulCount: { increment: 1 } }
          : { notHelpfulCount: { increment: 1 } },
      });
    });

    return this.counters(article.id);
  }

  forms(viewer: AuthenticatedUser | null) {
    return this.db.webForm.findMany({
      where: { isActive: true, ...(viewer ? {} : { requireLogin: false }) },
      select: FORM_SELECT,
      orderBy: { name: 'asc' },
    });
  }

  async form(slug: string, viewer: AuthenticatedUser | null) {
    const form = await this.db.webForm.findFirst({
      where: { slug, isActive: true },
      select: FORM_SELECT,
    });
    if (!form) {
      throw AppError.notFound('form');
    }
    if (form.requireLogin && !viewer) {
      throw AppError.unauthenticated('Sign in to use this form');
    }
    return form;
  }

  /**
   * A submission becomes a ticket through the same path as every other channel, so it
   * is routed, given an SLA and put through automation exactly like an agent's ticket.
   */
  async submitForm(
    helpCenter: PortalHelpCenter,
    slug: string,
    viewer: AuthenticatedUser | null,
    values: Record<string, unknown>,
  ) {
    if (!helpCenter.allowTicketSubmission) {
      throw AppError.validation('This help center is not accepting requests right now');
    }

    const form = await this.db.webForm.findFirst({
      where: { slug, isActive: true },
      select: { ...FORM_SELECT, departmentId: true, categoryId: true, priorityId: true },
    });
    if (!form) {
      throw AppError.notFound('form');
    }
    if (form.requireLogin && !viewer) {
      throw AppError.unauthenticated('Sign in to use this form');
    }

    const fields = webFormFieldListSchema.parse(form.fields);
    const submission = readSubmission(fields, values, form.name);

    const contactId = viewer?.contactId ?? (await this.resolveContact(submission));
    if (!contactId) {
      throw AppError.validation('An email address is required to raise a request');
    }

    const ticket = await this.tickets.createTicket({
      organizationId: helpCenter.organizationId,
      subject: submission.subject,
      description: submission.description,
      source: 'WEB_FORM',
      contactId,
      departmentId: form.departmentId,
      categoryId: form.categoryId,
      priorityId: form.priorityId,
      customFields: Object.keys(submission.customFields).length > 0 ? submission.customFields : null,
      createdById: viewer?.id ?? null,
    });

    await this.db.webForm.update({
      where: { id: form.id },
      data: { submissionCount: { increment: 1 } },
    });

    return {
      ticketId: ticket.id,
      ticketNumber: ticket.ticketNumber,
      subject: ticket.subject,
      successMessage: form.successMessage,
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Reuses the contact behind the email address, creating one the first time. */
  private async resolveContact(submission: SubmissionResult): Promise<string | null> {
    if (!submission.email) {
      return null;
    }

    const existing = await this.db.contact.findFirst({
      where: { email: submission.email },
      select: { id: true },
    });
    if (existing) {
      return existing.id;
    }

    const [firstName, ...rest] = (submission.name ?? submission.email).trim().split(/\s+/);
    const contact = await this.db.contact.create({
      data: {
        organizationId: TenantContext.requireOrganizationId(),
        firstName: firstName || submission.email,
        lastName: rest.join(' ') || null,
        email: submission.email,
        phone: submission.phone,
      },
      select: { id: true },
    });
    return contact.id;
  }

  private articleFilter(
    viewer: AuthenticatedUser | null,
    categoryId?: string,
    id?: string,
  ): Prisma.KbArticleWhereInput {
    return {
      status: 'PUBLISHED',
      visibility: { in: visibleTo(viewer) },
      ...(categoryId ? { categoryId } : {}),
      ...(id ? { id } : {}),
      // An article in a hidden category is hidden with it; one with no category is not.
      OR: [
        { categoryId: null },
        { category: { isActive: true, visibility: { in: visibleTo(viewer) } } },
      ],
    };
  }

  private async counters(articleId: string) {
    return this.db.kbArticle.findUniqueOrThrow({
      where: { id: articleId },
      select: { id: true, helpfulCount: true, notHelpfulCount: true },
    });
  }
}
