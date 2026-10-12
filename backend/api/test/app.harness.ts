import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import type { Redis } from 'ioredis';
import { PrismaClient } from '@digisoft/db';
import { AppModule } from '../src/app.module';
import { AppConfig } from '../src/config/config.module';
import { REDIS_CLIENT } from '../src/redis/redis.module';
import { applyGlobalPrefix } from '../src/common/app-prefix';

export interface Harness {
  app: INestApplication;
  prisma: PrismaClient;
  redis: Redis;
  close: () => Promise<void>;
}

/**
 * Boots the real application against the test database — no mocked layers.
 * Rate limiting follows THROTTLE_ENABLED, which the jest setup turns off so suites
 * can replay the same route; rate-limit.e2e-spec.ts turns it back on for itself.
 */
export async function createHarness(): Promise<Harness> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

  const app = moduleRef.createNestApplication();
  const config = app.get(AppConfig);
  applyGlobalPrefix(app, config.get('API_PREFIX'));
  app.use(cookieParser());
  await app.init();

  const prisma = new PrismaClient();
  const redis = app.get<Redis>(REDIS_CLIENT);

  return {
    app,
    prisma,
    redis,
    close: async () => {
      await app.close();
      await prisma.$disconnect();
      await redis.quit().catch(() => undefined);
    },
  };
}

/**
 * Wipes every table between suites so each one starts from a known state. Pass the
 * Redis client too when the suite exercises the portal: the help center is cached by
 * slug, and a re-registered organization would otherwise be resolved to the id of the
 * organization the previous test deleted.
 */
export async function resetDatabase(prisma: PrismaClient, redis?: Redis): Promise<void> {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      ai_insights, ai_settings,
      ticket_daily_metrics, agent_daily_metrics,
      report_exports, report_definitions, csat_responses, csat_settings,
      api_keys, webhook_deliveries, webhook_endpoints,
      chat_sessions, channel_events, channel_identities, channels,
      community_votes, community_replies, community_topics, community_categories,
      kb_article_feedback, kb_articles, kb_categories, web_forms, help_centers,
      activities, automation_runs, automation_rules, assignment_rules,
      blueprint_transitions, blueprints, sla_targets, sla_policies,
      attachments, ticket_links, ticket_followers, ticket_tags, ticket_messages,
      tickets, tags, ticket_categories, ticket_priorities, ticket_statuses,
      audit_logs, notifications, verification_tokens, refresh_tokens,
      team_members, teams, user_departments, departments,
      user_roles, role_permissions, roles, external_identities,
      contacts, accounts, holidays, business_hours, users, organizations
    RESTART IDENTITY CASCADE;
  `);

  if (redis) {
    await redis.flushdb();
  }
}

export const apiPath = (path: string): string => `/api/v1${path}`;

export interface SeededOrg {
  token: string;
  organizationId: string;
  userId: string;
  slug: string;
}

/** Registers an organization and returns a signed-in super admin for it. */
export async function registerOrg(
  http: import('node:http').Server,
  slug: string,
  email = `owner@${slug}.example`,
): Promise<SeededOrg> {
  const request = (await import('supertest')).default;
  const response = await request(http)
    .post(apiPath('/auth/register'))
    .send({
      organizationName: `${slug} Co`,
      organizationSlug: slug,
      firstName: 'Olive',
      lastName: 'Owner',
      email,
      password: 'Str0ngPassword1',
    })
    .expect(201);

  return {
    token: response.body.data.accessToken as string,
    organizationId: response.body.data.user.organizationId as string,
    userId: response.body.data.user.id as string,
    slug,
  };
}
