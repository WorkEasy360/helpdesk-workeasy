import type { ChannelType } from '@digisoft/shared';

/** Credentials as the API hands them to a provider: decrypted, never logged. */
export type ChannelSecrets = Record<string, string>;
export type ChannelConfig = Record<string, unknown>;

export interface InboundAttachment {
  fileName: string;
  mimeType: string;
  /** Either the bytes inline or a URL the adapter can fetch with its own credentials. */
  contentBase64?: string;
  url?: string;
}

/** One message as it arrived, in the shape the ingestion pipeline understands. */
export interface InboundMessage {
  /** Provider's id for this message; the dedupe key for the whole pipeline. */
  externalId: string;
  /** Who sent it, in the channel's own identity space. */
  from: {
    externalId: string;
    name?: string;
    email?: string;
    phone?: string;
  };
  /** Address, number or page this arrived at — used to pick the channel when routing. */
  to?: string;
  text: string;
  html?: string;
  subject?: string;
  attachments?: InboundAttachment[];
  /** Threading hints; for email these are Message-ID values. */
  inReplyTo?: string;
  references?: string[];
  receivedAt?: Date;
  /**
   * True for anything machine-generated — auto-replies, bounces, vacation notices.
   * The pipeline stores these as IGNORED rather than answering them, which is what
   * stops two auto-responders from talking to each other forever.
   */
  isAutomated?: boolean;
  /** Provider-specific extras the pipeline may use (call status, media ids, …). */
  meta?: Record<string, unknown>;
}

export interface OutboundMessage {
  /** External identity to deliver to (address, E.164 number, chat id, PSID). */
  to: string;
  text: string;
  html?: string;
  subject?: string;
  inReplyTo?: string | null;
  references?: string[];
  attachments?: { fileName: string; mimeType: string; url: string }[];
}

export interface VerifyInput {
  /** Exact bytes as received — signatures are computed over these, not over re-encoded JSON. */
  rawBody: string;
  headers: Record<string, string | undefined>;
  query: Record<string, string | undefined>;
}

export interface ParseContext {
  /** The channel's own identifier, used to drop events addressed to someone else. */
  identifier?: string | null;
  config: ChannelConfig;
}

/**
 * What every channel adapter implements. Adapters are pure with respect to the
 * database: they verify, parse and send, and know nothing about tickets.
 */
export interface ChannelProvider {
  readonly key: string;
  readonly type: ChannelType;
  /** Meta-style GET verification; return the echo string when the challenge is valid. */
  challenge?(query: Record<string, string | undefined>, secrets: ChannelSecrets): string | null;
  /**
   * False when the provider supports its own request authentication (signature, secret
   * header, basic credentials) but the channel has none configured, leaving the webhook
   * URL secret as the only credential. Omitted when verification is always enforced.
   */
  hasProviderAuth?(secrets: ChannelSecrets): boolean;
  /** Signature/secret check over the raw body. Returning false means 401 at the edge. */
  verify(input: VerifyInput, secrets: ChannelSecrets): boolean;
  parse(payload: unknown, context: ParseContext): InboundMessage[];
  send?(
    message: OutboundMessage,
    secrets: ChannelSecrets,
    config: ChannelConfig,
  ): Promise<{ externalId: string | null }>;
}

export class ChannelError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ChannelError';
  }
}
