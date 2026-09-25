import type {
  ChannelProvider,
  ChannelConfig,
  ChannelSecrets,
  InboundMessage,
  OutboundMessage,
  ParseContext,
  VerifyInput,
} from '../types';
import { ChannelError } from '../types';
import { safeEqual } from '../crypto';

const API = 'https://api.telegram.org';

function record(value: unknown): Record<string, unknown> {
  return (value ?? {}) as Record<string, unknown>;
}
function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
function num(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

/**
 * Telegram Bot API. Updates arrive on the webhook and are authenticated with the
 * secret token Telegram echoes back in `X-Telegram-Bot-Api-Secret-Token`.
 */
export const telegramProvider: ChannelProvider = {
  key: 'telegram',
  type: 'TELEGRAM',

  hasProviderAuth(secrets: ChannelSecrets): boolean {
    return Boolean(secrets['secretToken']);
  },

  verify(input: VerifyInput, secrets: ChannelSecrets): boolean {
    const expected = secrets['secretToken'];
    if (!expected) {
      // Without a secret token the unguessable webhook URL is the only credential.
      return true;
    }
    const provided = input.headers['x-telegram-bot-api-secret-token'];
    return provided !== undefined && safeEqual(provided, expected);
  },

  parse(payload: unknown, _context: ParseContext): InboundMessage[] {
    const update = record(payload);
    const message = record(update['message'] ?? update['edited_message']);
    const chat = record(message['chat']);
    const from = record(message['from']);
    const chatId = num(chat['id']);
    const text = str(message['text']) ?? str(message['caption']);
    const updateId = num(update['update_id']);
    const messageId = num(message['message_id']);

    if (chatId === undefined || messageId === undefined || !text) {
      // Stickers, joins and other updates are acknowledged but carry no conversation.
      return [];
    }

    const name = [str(from['first_name']), str(from['last_name'])].filter(Boolean).join(' ').trim();

    return [
      {
        externalId: `telegram:${updateId ?? `${chatId}:${messageId}`}`,
        from: {
          externalId: String(chatId),
          name: name || str(from['username']) || `Telegram ${chatId}`,
        },
        to: String(chatId),
        text,
        receivedAt: num(message['date']) ? new Date(num(message['date'])! * 1000) : undefined,
        meta: { chatId, messageId, username: str(from['username']) },
      },
    ];
  },

  async send(
    message: OutboundMessage,
    secrets: ChannelSecrets,
    _config: ChannelConfig,
  ): Promise<{ externalId: string | null }> {
    const token = secrets['botToken'];
    if (!token) {
      throw new ChannelError('This Telegram channel has no bot token configured');
    }

    const response = await fetch(`${API}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: message.to, text: message.text }),
    });
    const body = record(await response.json().catch(() => ({})));
    if (!response.ok || body['ok'] !== true) {
      throw new ChannelError(
        `Telegram refused the message: ${str(body['description']) ?? response.statusText}`,
        response.status,
      );
    }
    const result = record(body['result']);
    return { externalId: num(result['message_id']) ? String(num(result['message_id'])) : null };
  },
};
