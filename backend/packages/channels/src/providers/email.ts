import { createHmac } from 'node:crypto';
import type {
  ChannelProvider,
  ChannelSecrets,
  InboundAttachment,
  InboundMessage,
  ParseContext,
  VerifyInput,
} from '../types';
import { safeEqual } from '../crypto';

interface EmailAddress {
  address: string;
  name?: string;
}

/** `"Rhea Kapoor" <rhea@example.com>` and the plainer forms around it. */
export function parseAddress(raw: string | undefined | null): EmailAddress | null {
  if (!raw) {
    return null;
  }
  const angled = /^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/.exec(raw);
  if (angled) {
    const address = angled[2]?.trim().toLowerCase();
    if (!address) return null;
    const name = angled[1]?.trim();
    return name ? { address, name } : { address };
  }
  const bare = raw.trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+$/.test(bare) ? { address: bare } : null;
}

/** Splits `References:` into individual Message-IDs. */
export function parseReferences(raw: string | undefined | null): string[] {
  if (!raw) {
    return [];
  }
  return raw.match(/<[^>]+>/g)?.map((value) => value.trim()) ?? [];
}

const QUOTE_MARKERS = [
  /^On .+ wrote:$/m,
  /^-----Original Message-----$/m,
  /^_{10,}$/m,
  /^From: .+$/m,
];

/**
 * Removes the quoted history a mail client appends to a reply. Conservative on
 * purpose: it cuts at the first recognised marker and keeps everything above it, so a
 * missed marker costs a tidy thread, never a lost reply.
 */
export function stripQuotedText(body: string): string {
  let cut = body.length;
  for (const marker of QUOTE_MARKERS) {
    const match = marker.exec(body);
    if (match && match.index < cut) {
      cut = match.index;
    }
  }
  const quotedBlock = /\n(>[^\n]*\n){2,}/.exec(body);
  if (quotedBlock && quotedBlock.index < cut) {
    cut = quotedBlock.index;
  }
  const trimmed = body.slice(0, cut).trimEnd();
  return trimmed.length > 0 ? trimmed : body.trim();
}

/** True for anything a machine sent: vacation notices, bounces, list traffic. */
export function looksAutomated(headers: Record<string, string | undefined>): boolean {
  const get = (name: string) => headers[name.toLowerCase()]?.toLowerCase() ?? '';
  const autoSubmitted = get('auto-submitted');
  if (autoSubmitted && autoSubmitted !== 'no') {
    return true;
  }
  if (get('x-autoreply') || get('x-autorespond') || get('x-auto-response-suppress')) {
    return true;
  }
  if (['bulk', 'list', 'junk'].includes(get('precedence'))) {
    return true;
  }
  if (get('x-failed-recipients') || get('return-path') === '<>') {
    return true;
  }
  return /^(mailer-daemon|postmaster|no-?reply)@/i.test(get('from'));
}

/** Ticket reference in a subject, e.g. `Re: [#1042] Cannot log in`. */
export function ticketNumberFromSubject(subject: string | undefined): number | null {
  const match = /\[#(\d{1,9})\]/.exec(subject ?? '');
  return match?.[1] ? Number.parseInt(match[1], 10) : null;
}

export interface NormalisedEmail {
  messageId?: string;
  from?: string;
  to?: string;
  subject?: string;
  text?: string;
  html?: string;
  inReplyTo?: string;
  references?: string;
  headers?: Record<string, string | undefined>;
  attachments?: InboundAttachment[];
  receivedAt?: string;
}

/** Shared mapping: every email adapter normalises to `NormalisedEmail`, then this runs. */
export function toInboundMessage(email: NormalisedEmail, context: ParseContext): InboundMessage[] {
  const from = parseAddress(email.from);
  if (!from) {
    return [];
  }

  const headers = email.headers ?? {};
  const text = email.text ?? stripHtml(email.html ?? '');
  const shouldStrip = context.config['stripQuotedText'] !== false;

  return [
    {
      externalId: email.messageId ?? `${from.address}:${Date.now()}`,
      from: { externalId: from.address, name: from.name, email: from.address },
      to: parseAddress(email.to)?.address,
      subject: email.subject,
      text: shouldStrip ? stripQuotedText(text) : text,
      html: email.html,
      inReplyTo: email.inReplyTo,
      references: parseReferences(email.references),
      attachments: email.attachments ?? [],
      receivedAt: email.receivedAt ? new Date(email.receivedAt) : undefined,
      isAutomated: looksAutomated({ ...headers, from: email.from }),
    },
  ];
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function record(value: unknown): Record<string, unknown> {
  return (value ?? {}) as Record<string, unknown>;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/**
 * Fields of a request body that may be JSON or form-encoded. Mailgun routes post
 * `application/x-www-form-urlencoded` (or multipart, which the edge flattens to the same
 * urlencoded shape before verification), so the raw bytes are not always JSON.
 */
function bodyFields(input: VerifyInput): Record<string, unknown> {
  const type = input.headers['content-type']?.toLowerCase() ?? '';
  if (!type.includes('application/x-www-form-urlencoded')) {
    const parsed = parseJson(input.rawBody);
    if (parsed && typeof parsed === 'object') {
      return record(parsed);
    }
  }
  return Object.fromEntries(new URLSearchParams(input.rawBody).entries());
}

/** Mailgun's `message-headers`: a JSON list of `[name, value]` pairs. */
function headerPairs(value: unknown): Record<string, string | undefined> {
  const list = typeof value === 'string' ? parseJson(value) : value;
  const out: Record<string, string | undefined> = {};
  if (!Array.isArray(list)) {
    return out;
  }
  for (const pair of list) {
    if (Array.isArray(pair) && typeof pair[0] === 'string' && typeof pair[1] === 'string') {
      out[pair[0].toLowerCase()] ??= pair[1];
    }
  }
  return out;
}

function lowerKeys(value: unknown): Record<string, string | undefined> {
  const source = record(value);
  const out: Record<string, string | undefined> = {};
  for (const [key, item] of Object.entries(source)) {
    if (typeof item === 'string') {
      out[key.toLowerCase()] = item;
    }
  }
  return out;
}

function attachmentsFrom(value: unknown): InboundAttachment[] {
  // Form-encoded posts (Mailgun) carry structured fields as JSON strings.
  const list = typeof value === 'string' ? parseJson(value) : value;
  if (!Array.isArray(list)) {
    return [];
  }
  const attachments: InboundAttachment[] = [];
  for (const entry of list) {
    const item = record(entry);
    const fileName = str(item['fileName']) ?? str(item['name']) ?? str(item['Name']);
    const mimeType =
      str(item['mimeType']) ??
      str(item['contentType']) ??
      str(item['ContentType']) ??
      str(item['content-type']) ??
      'application/octet-stream';
    const contentBase64 = str(item['contentBase64']) ?? str(item['content']) ?? str(item['Content']);
    const url = str(item['url']);
    if (!fileName || (!contentBase64 && !url)) {
      continue;
    }
    attachments.push({ fileName, mimeType, ...(contentBase64 ? { contentBase64 } : {}), ...(url ? { url } : {}) });
  }
  return attachments;
}

/**
 * The documented JSON shape this product accepts from any mail relay, so an operator
 * can wire up a provider we have not written an adapter for. Optionally authenticated
 * with an HMAC over the raw body.
 */
export const genericEmailProvider: ChannelProvider = {
  key: 'generic',
  type: 'EMAIL',

  hasProviderAuth(secrets: ChannelSecrets): boolean {
    return Boolean(secrets['signingSecret']);
  },

  verify(input: VerifyInput, secrets: ChannelSecrets): boolean {
    const signingSecret = secrets['signingSecret'];
    if (!signingSecret) {
      // No secret configured: the unguessable webhook URL is the only credential. The
      // edge logs a warning for channels left in this state.
      return true;
    }
    const signature = input.headers['x-digisoft-signature'];
    if (!signature) {
      return false;
    }
    const expected = createHmac('sha256', signingSecret).update(input.rawBody).digest('hex');
    return safeEqual(signature, expected);
  },

  parse(payload: unknown, context: ParseContext): InboundMessage[] {
    const body = record(payload);
    return toInboundMessage(
      {
        messageId: str(body['messageId']),
        from: str(body['from']),
        to: str(body['to']),
        subject: str(body['subject']),
        text: str(body['text']),
        html: str(body['html']),
        inReplyTo: str(body['inReplyTo']),
        references: str(body['references']),
        headers: lowerKeys(body['headers']),
        attachments: attachmentsFrom(body['attachments']),
        receivedAt: str(body['receivedAt']),
      },
      context,
    );
  },
};

/**
 * Mailgun routes ("forward" and "store and notify"), verified with the signing key.
 * Mailgun posts form fields — urlencoded, or multipart when the message has files — and
 * signs `timestamp + token` rather than the body, so verification only needs the three
 * signature fields wherever they appear. JSON bodies are accepted too.
 */
export const mailgunEmailProvider: ChannelProvider = {
  key: 'mailgun',
  type: 'EMAIL',

  hasProviderAuth: () => true,

  verify(input: VerifyInput, secrets: ChannelSecrets): boolean {
    const signingKey = secrets['signingKey'];
    if (!signingKey) {
      return false;
    }
    const body = bodyFields(input);
    const signature = record(body['signature']);
    const timestamp = str(signature['timestamp']) ?? str(body['timestamp']);
    const token = str(signature['token']) ?? str(body['token']);
    const provided = str(signature['signature']) ?? str(body['signature']);
    if (!timestamp || !token || !provided) {
      return false;
    }
    // Replays outside five minutes are refused even when the signature is valid.
    const age = Math.abs(Date.now() / 1000 - Number.parseInt(timestamp, 10));
    if (!Number.isFinite(age) || age > 300) {
      return false;
    }
    const expected = createHmac('sha256', signingKey).update(`${timestamp}${token}`).digest('hex');
    return safeEqual(provided, expected);
  },

  parse(payload: unknown, context: ParseContext): InboundMessage[] {
    const body = record(payload);
    const message = record(body['message-headers'] ? body : body['event-data']);
    const headers = {
      ...headerPairs(body['message-headers']),
      ...lowerKeys(body['headers'] ?? message['headers']),
    };
    return toInboundMessage(
      {
        messageId: str(body['Message-Id']) ?? str(body['message-id']) ?? headers['message-id'],
        from: str(body['from']) ?? str(body['sender']) ?? headers['from'],
        to: str(body['recipient']) ?? str(body['To']) ?? headers['to'],
        subject: str(body['subject']) ?? str(body['Subject']),
        text: str(body['stripped-text']) ?? str(body['body-plain']),
        html: str(body['body-html']) ?? str(body['stripped-html']),
        inReplyTo: str(body['In-Reply-To']) ?? headers['in-reply-to'],
        references: str(body['References']) ?? headers['references'],
        headers,
        attachments: attachmentsFrom(body['attachments']),
        receivedAt: str(body['Date']),
      },
      context,
    );
  },
};

/** Postmark inbound webhooks, authenticated with HTTP basic credentials. */
export const postmarkEmailProvider: ChannelProvider = {
  key: 'postmark',
  type: 'EMAIL',

  hasProviderAuth(secrets: ChannelSecrets): boolean {
    return Boolean(secrets['webhookUsername'] || secrets['webhookPassword']);
  },

  verify(input: VerifyInput, secrets: ChannelSecrets): boolean {
    const user = secrets['webhookUsername'];
    const password = secrets['webhookPassword'];
    if (!user && !password) {
      // Basic credentials not configured: the webhook URL secret is the only guard.
      return true;
    }
    const header = input.headers['authorization'];
    if (!header?.startsWith('Basic ')) {
      return false;
    }
    const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
    return safeEqual(decoded, `${user ?? ''}:${password ?? ''}`);
  },

  parse(payload: unknown, context: ParseContext): InboundMessage[] {
    const body = record(payload);
    const headerList = Array.isArray(body['Headers']) ? body['Headers'] : [];
    const headers: Record<string, string | undefined> = {};
    for (const entry of headerList) {
      const item = record(entry);
      const name = str(item['Name']);
      if (name) {
        headers[name.toLowerCase()] = str(item['Value']);
      }
    }
    const fromFull = record(body['FromFull']);
    const from =
      str(fromFull['Name']) && str(fromFull['Email'])
        ? `"${str(fromFull['Name'])}" <${str(fromFull['Email'])}>`
        : (str(body['From']) ?? str(fromFull['Email']));

    return toInboundMessage(
      {
        messageId: str(body['MessageID']) ?? headers['message-id'],
        from,
        to: str(body['OriginalRecipient']) ?? str(body['To']),
        subject: str(body['Subject']),
        text: str(body['StrippedTextReply']) ?? str(body['TextBody']),
        html: str(body['HtmlBody']),
        inReplyTo: headers['in-reply-to'],
        references: headers['references'],
        headers,
        attachments: attachmentsFrom(body['Attachments']),
        receivedAt: str(body['Date']),
      },
      context,
    );
  },
};
