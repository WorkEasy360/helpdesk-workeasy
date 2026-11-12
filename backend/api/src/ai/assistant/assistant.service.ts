import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ASSISTANT_PAGES,
  ASSISTANT_RECORDS,
  AiError,
  ASSISTANT_PROMPT,
  assistantCapabilities,
  assistantSuggestions,
  assistantSystem,
  createAssistantProvider,
  loadSettings,
  runAssistantTurn,
  type AssistantContext,
  type AssistantToolOutcome,
  type JsonCompletionProvider,
} from '@digisoft/ai';
import type {
  AssistantAnswer,
  AssistantAskInput,
  AssistantLink,
  AssistantWelcome,
  AuthenticatedUser,
} from '@digisoft/shared';
import type { TenantPrismaClient } from '@digisoft/db';
import { TENANT_PRISMA } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { AppConfig } from '../../config/config.module';
import { AppError } from '../../common/errors/app-error';
import { ASSISTANT_TOOL_RUNNERS } from './assistant.tools';
import { verifyAction } from './assistant.actions';

/**
 * The workspace assistant's request path. Three steps, in this order, every time:
 *
 * 1. **Allowance.** One question is taken from today's count *before* the model is
 *    called, so a failed answer still costs its question and a burst cannot slip past.
 * 2. **The loop.** The model sees only the tools, actions and pages this member's role
 *    allows, and each tool re-checks that permission when it runs.
 * 3. **Resolution.** The link and the action on the answer are checked against the
 *    workspace as it is now. A link the role cannot open is dropped; an action becomes
 *    a card the member confirms, or a sentence saying why it cannot be done.
 *
 * What is logged: the tools used, whether the turn succeeded, and token counts.
 * Questions, answers and tool data are not.
 */
@Injectable()
export class AssistantService {
  private readonly logger = new Logger(AssistantService.name);

  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
  ) {}

  /**
   * What the chat shows before the first question.
   *
   * The assistant is always on. There is no setting that switches it off, and none is
   * needed: an organization with no model provider configured still gets a working
   * chat from the built-in deterministic one. The only gate is the `ai.use`
   * permission, which the route enforces and which keeps the button from rendering.
   */
  async welcome(actor: AuthenticatedUser): Promise<AssistantWelcome> {
    const settings = await loadSettings({ prisma: this.prisma }, actor.organizationId);
    const used = await this.usedToday(actor.organizationId);
    const limit = settings.assistantDailyLimit;

    return {
      // Always true: this product has no switch. Kept so the response matches the
      // shared assistant-UI contract that the panel is built against.
      enabled: true,
      provider: this.provider().kind,
      suggestions: assistantSuggestions((permission) => actor.permissions.includes(permission)),
      dailyLimit: limit,
      remainingToday: limit > 0 ? Math.max(0, limit - used) : null,
    };
  }

  async ask(actor: AuthenticatedUser, input: AssistantAskInput): Promise<AssistantAnswer> {
    const settings = await loadSettings({ prisma: this.prisma }, actor.organizationId);

    // The daily allowance is the only thing that can refuse a question, and it is a
    // spend guard rather than a switch: 0 means no limit.
    const remaining = await this.takeOneQuestion(actor.organizationId, settings.assistantDailyLimit);

    const can = (permission: string) => actor.permissions.includes(permission);
    const capabilities = assistantCapabilities(can);

    const organization = await this.db.organization.findFirst({
      select: { name: true, slug: true, timezone: true },
    });

    const context: AssistantContext = {
      organizationName: organization?.name ?? 'this organization',
      organizationSlug: organization?.slug ?? '',
      memberName: `${actor.firstName} ${actor.lastName}`.trim(),
      memberEmail: actor.email,
      roles: actor.roles,
      timezone: organization?.timezone ?? 'UTC',
      today: new Date().toISOString().slice(0, 10),
      guidance: settings.promptGuidance,
      ...capabilities,
    };

    const provider = this.provider();
    const allowedTools = new Set(capabilities.tools.map((tool) => tool.name));

    const runTool = async (
      name: string,
      args: Record<string, unknown>,
    ): Promise<AssistantToolOutcome> => {
      if (!allowedTools.has(name)) {
        return { ok: false, error: `There is no tool called "${name}" available to you.` };
      }
      const runner = ASSISTANT_TOOL_RUNNERS[name];
      if (!runner) return { ok: false, error: `The tool "${name}" is not implemented.` };
      try {
        // Each tool is its own short read, scoped to the organization by the tenant
        // extension and re-checked against the member's permissions inside the runner.
        return await runner(args, {
          db: this.db,
          actor,
          timezone: context.timezone,
        });
      } catch (error) {
        this.logger.warn(`assistant tool ${name} failed: ${String(error)}`);
        return { ok: false, error: 'That lookup failed. Try a different one.' };
      }
    };

    let turn;
    try {
      turn = await runAssistantTurn({
        provider,
        system: assistantSystem(ASSISTANT_PROMPT, context),
        history: input.history.map((turn) => ({ role: turn.role, text: turn.content })),
        question: input.question,
        runTool,
      });
    } catch (error) {
      this.logger.warn(
        `assistant turn failed org=${actor.organizationId} provider=${provider.kind}: ${String(error)}`,
      );
      if (error instanceof AiError) throw AppError.validation(error.message);
      throw AppError.validation('The assistant could not answer that. Try again in a moment.');
    }

    this.logger.log(
      `assistant turn org=${actor.organizationId} provider=${provider.kind} tools=[${turn.usedTools.join(',')}] ` +
        `in=${turn.usage.inputTokens} out=${turn.usage.outputTokens}`,
    );

    const [link, proposal] = await Promise.all([
      this.resolveLink(turn.answer.navigate, actor),
      this.resolveAction(turn.answer.action, actor, capabilities.actions.map((a) => a.kind)),
    ]);

    return {
      text: turn.answer.text,
      link,
      proposal: proposal.proposal,
      // The member asked for a change and the server refused it. Reported separately,
      // so the panel shows it as a hint under the answer rather than burying it in prose.
      actionNote: proposal.note ?? null,
      usedTools: turn.usedTools,
      remainingToday: remaining,
    };
  }

  /**
   * The assistant runs on the deployment's own key, from the environment — not on the
   * per-organization `AiSettings` row, which stays the source for the per-ticket
   * insights. One operator key for a product feature; per-tenant keys for per-tenant
   * billing.
   */
  private provider(): JsonCompletionProvider {
    return createAssistantProvider({
      provider: this.config.get('AI_PROVIDER'),
      model: this.config.get('AI_MODEL'),
      apiKey: this.config.get('AI_API_KEY') ?? null,
    });
  }

  /** Questions used by this organization today, in its own row. */
  private async usedToday(organizationId: string): Promise<number> {
    const row = await this.db.aiUsageDay.findFirst({
      where: { organizationId, day: today() },
      select: { assistantMessages: true },
    });
    return row?.assistantMessages ?? 0;
  }

  /**
   * Takes one question from today's allowance, or refuses. The increment and the check
   * are one statement so two questions arriving together cannot both see the last slot.
   * Returns what is left, or null when the organization has no limit.
   */
  private async takeOneQuestion(organizationId: string, limit: number): Promise<number | null> {
    const row = await this.db.aiUsageDay.upsert({
      where: { organizationId_day: { organizationId, day: today() } },
      create: { organizationId, day: today(), assistantMessages: 1 },
      update: { assistantMessages: { increment: 1 } },
      select: { assistantMessages: true },
    });

    if (limit <= 0) return null;
    if (row.assistantMessages > limit) {
      throw AppError.validation(
        `This organization has used all ${limit} assistant questions for today. The allowance resets at midnight UTC.`,
      );
    }
    return Math.max(0, limit - row.assistantMessages);
  }

  /**
   * A page key or a `<record>:<id>` reference, checked against the role and against the
   * record actually existing. Anything else is dropped — the model never builds a path.
   */
  private async resolveLink(
    navigate: string | null,
    actor: AuthenticatedUser,
  ): Promise<AssistantLink | null> {
    if (!navigate) return null;
    const can = (permission: string) => actor.permissions.includes(permission);
    const allowed = (permission: readonly string[] | null) =>
      permission === null || permission.every(can);

    const page = ASSISTANT_PAGES.find((entry) => entry.key === navigate);
    if (page) return allowed(page.permission) ? { label: page.label, path: page.path } : null;

    const [kind, id] = navigate.split(':', 2);
    if (!kind || !id) return null;
    const record = ASSISTANT_RECORDS[kind as keyof typeof ASSISTANT_RECORDS];
    if (!record || !allowed(record.permission)) return null;

    const label = await this.describeRecord(kind, id, actor);
    return label ? { label, path: record.path(id) } : null;
  }

  /** Confirms the record exists and this member may open it, and names it. */
  private async describeRecord(
    kind: string,
    id: string,
    actor: AuthenticatedUser,
  ): Promise<string | null> {
    try {
      if (kind === 'ticket') {
        const { ticketVisibilityFilter } = await import('../../tickets/ticket-visibility');
        const ticket = await this.db.ticket.findFirst({
          where: { AND: [{ id }, ticketVisibilityFilter(actor)] },
          select: { ticketNumber: true, subject: true },
        });
        return ticket ? `Ticket #${ticket.ticketNumber} · ${ticket.subject}` : null;
      }
      if (kind === 'contact') {
        const contact = await this.db.contact.findFirst({
          where: { id },
          select: { firstName: true, lastName: true },
        });
        return contact ? `${contact.firstName} ${contact.lastName ?? ''}`.trim() : null;
      }
      if (kind === 'account') {
        const account = await this.db.account.findFirst({ where: { id }, select: { name: true } });
        return account?.name ?? null;
      }
      if (kind === 'article') {
        const article = await this.db.kbArticle.findFirst({ where: { id }, select: { title: true } });
        return article?.title ?? null;
      }
    } catch {
      return null;
    }
    return null;
  }

  /** Checks the proposed action, and says why when it cannot be offered. */
  private async resolveAction(
    action: Record<string, unknown> | null,
    actor: AuthenticatedUser,
    allowedKinds: string[],
  ): Promise<{ proposal: AssistantAnswer['proposal']; note?: string }> {
    if (!action) return { proposal: null };

    const kind = typeof action['kind'] === 'string' ? action['kind'] : '';
    if (!allowedKinds.includes(kind)) {
      return { proposal: null, note: 'I cannot prepare that change for you.' };
    }

    const outcome = await verifyAction(action, { db: this.db, actor });
    return outcome.ok ? { proposal: outcome.proposal } : { proposal: null, note: outcome.reason };
  }
}

/** Midnight UTC today, matching the `@db.Date` column the allowance is counted in. */
function today(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
