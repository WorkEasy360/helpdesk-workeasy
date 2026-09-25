export type EmailTemplate =
  | { kind: 'verify-email'; firstName: string; url: string }
  | {
      kind: 'reset-password';
      firstName: string;
      url: string;
      expiresInMinutes: number;
      /** Named when the address has accounts in several organizations. */
      organizationName?: string;
    }
  | { kind: 'invite'; firstName: string; organizationName: string; url: string }
  | { kind: 'password-changed'; firstName: string }
  | {
      kind: 'csat-survey';
      subject: string;
      contactName: string;
      organizationName: string;
      ticketNumber: number;
      ticketSubject: string;
      introText: string;
      url: string;
    };

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function layout(title: string, bodyHtml: string): string {
  return `<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#18181b;line-height:1.5">
<h2 style="font-size:18px;margin:0 0 16px">${escapeHtml(title)}</h2>
${bodyHtml}
<p style="color:#71717a;font-size:12px;margin-top:24px">Digisoft360 Help Desk</p>
</body></html>`;
}

function button(url: string, label: string): string {
  return `<p><a href="${escapeHtml(url)}" style="display:inline-block;background:#18181b;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">${escapeHtml(label)}</a></p>
<p style="font-size:12px;color:#71717a">If the button does not work, paste this link into your browser:<br>${escapeHtml(url)}</p>`;
}

/** One link per score, so a customer can answer from the email in a single click. */
function ratingLinks(url: string): string {
  const labels = ['1 — Very poor', '2 — Poor', '3 — Okay', '4 — Good', '5 — Excellent'];
  return `<p>${labels
    .map(
      (label, index) =>
        `<a href="${escapeHtml(`${url}?rating=${index + 1}`)}" style="display:inline-block;border:1px solid #d4d4d8;border-radius:6px;padding:8px 12px;margin:0 6px 6px 0;text-decoration:none;color:#18181b">${escapeHtml(label)}</a>`,
    )
    .join('')}</p>`;
}

export function renderEmail(template: EmailTemplate): RenderedEmail {
  switch (template.kind) {
    case 'verify-email':
      return {
        subject: 'Verify your email address',
        html: layout(
          `Hi ${template.firstName},`,
          `<p>Confirm your email address to finish setting up your Digisoft360 Help Desk account.</p>${button(template.url, 'Verify email')}`,
        ),
        text: `Hi ${template.firstName},\n\nVerify your email address: ${template.url}`,
      };
    case 'reset-password':
      return {
        subject: template.organizationName
          ? `Reset your ${template.organizationName} password`
          : 'Reset your password',
        html: layout(
          `Hi ${template.firstName},`,
          `<p>We received a request to reset your password${
            template.organizationName
              ? ` for <strong>${escapeHtml(template.organizationName)}</strong>`
              : ''
          }. This link expires in ${template.expiresInMinutes} minutes.</p>${button(template.url, 'Reset password')}<p>If you did not request this, you can ignore this email.</p>`,
        ),
        text: `Hi ${template.firstName},\n\nReset your ${
          template.organizationName ? `${template.organizationName} ` : ''
        }password (expires in ${template.expiresInMinutes} minutes): ${template.url}`,
      };
    case 'invite':
      return {
        subject: `You have been invited to ${template.organizationName}`,
        html: layout(
          `Hi ${template.firstName},`,
          `<p>You have been invited to join <strong>${escapeHtml(template.organizationName)}</strong> on Digisoft360 Help Desk.</p>${button(template.url, 'Accept invitation')}`,
        ),
        text: `Hi ${template.firstName},\n\nAccept your invitation to ${template.organizationName}: ${template.url}`,
      };
    case 'password-changed':
      return {
        subject: 'Your password was changed',
        html: layout(
          `Hi ${template.firstName},`,
          `<p>Your Digisoft360 Help Desk password was just changed. If this was not you, contact your administrator immediately.</p>`,
        ),
        text: `Hi ${template.firstName},\n\nYour password was just changed. If this was not you, contact your administrator immediately.`,
      };
    case 'csat-survey':
      return {
        subject: template.subject,
        html: layout(
          `Hi ${template.contactName},`,
          `<p>${escapeHtml(template.introText)}</p>` +
            `<p style="color:#71717a;font-size:13px">About ticket #${template.ticketNumber} — ${escapeHtml(template.ticketSubject)}</p>` +
            ratingLinks(template.url) +
            `<p style="font-size:12px;color:#71717a">Or open the survey directly:<br>${escapeHtml(template.url)}</p>`,
        ),
        text: `Hi ${template.contactName},\n\n${template.introText}\n\nTicket #${template.ticketNumber} — ${template.ticketSubject}\n\nRate your support: ${template.url}`,
      };
  }
}
