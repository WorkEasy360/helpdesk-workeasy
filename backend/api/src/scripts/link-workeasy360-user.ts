import { parseArgs } from 'node:util';
import { PrismaClient } from '@digisoft/db';
import { LinkUserError, linkUser } from '../workeasy360/link-user';

const USAGE =
  'Usage: link-workeasy360-user --email <account address> --subject <Workeasy360 sub> ' +
  '--organization <Workeasy360 organization id> --actor <who vouches> --reason <why> [--issuer <issuer>]';

/**
 * Links one existing Help Desk account to its person's Workeasy360 account, because an operator
 * vouches that they are the same person. A Workeasy360 sign-in never does this by itself: one that
 * finds an account with the same address is refused with `account_conflict`.
 *
 * The issuer defaults to WORKEASY360_ISSUER. The link is written to the organization's audit log
 * with the actor and the reason.
 */
async function main(): Promise<number> {
  let values: Record<string, string | undefined>;
  try {
    ({ values } = parseArgs({
      options: {
        email: { type: 'string' },
        subject: { type: 'string' },
        organization: { type: 'string' },
        actor: { type: 'string' },
        reason: { type: 'string' },
        issuer: { type: 'string' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
    return 2;
  }
  const missing = ['email', 'subject', 'organization', 'actor', 'reason'].filter((name) => !values[name]?.trim());
  if (missing.length > 0) {
    console.error(`Missing: ${missing.map((name) => `--${name}`).join(', ')}`);
    console.error(USAGE);
    return 2;
  }

  const prisma = new PrismaClient();
  try {
    const result = await linkUser(prisma, {
      email: values['email']!,
      subject: values['subject']!,
      workeasy360OrganizationId: values['organization']!,
      issuer: values['issuer'] ?? process.env['WORKEASY360_ISSUER'] ?? '',
      actor: values['actor']!,
      reason: values['reason']!,
    });
    if (!result.changed) {
      console.log(`${result.email} is already linked to ${result.subject} at ${result.issuer}; nothing changed.`);
      return 0;
    }
    console.log(
      `Linked ${result.email} (${result.userId}) in "${result.organizationName}" to Workeasy360 account ` +
        `${result.subject} at ${result.issuer}. Recorded in the organization's audit log.`,
    );
    console.log(
      `${result.sessionsEnded} open session(s) of the account ended; the person signs in again with Workeasy360. ` +
        'The password is unchanged: with WORKEASY360_SSO_ONLY on it opens nothing.',
    );
    return 0;
  } catch (error) {
    if (error instanceof LinkUserError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

void main().then((code) => process.exit(code));
