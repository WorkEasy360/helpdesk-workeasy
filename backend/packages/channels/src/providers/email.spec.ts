import { createHmac } from 'node:crypto';
import {
  genericEmailProvider,
  looksAutomated,
  mailgunEmailProvider,
  parseAddress,
  parseReferences,
  postmarkEmailProvider,
  stripQuotedText,
  ticketNumberFromSubject,
} from './email';

const context = { identifier: 'support@example.com', config: {} };

describe('email address parsing', () => {
  it('reads the display name and lowercases the address', () => {
    expect(parseAddress('"Rhea Kapoor" <Rhea@Example.com>')).toEqual({
      address: 'rhea@example.com',
      name: 'Rhea Kapoor',
    });
    expect(parseAddress('plain@example.com')).toEqual({ address: 'plain@example.com' });
    expect(parseAddress('not an address')).toBeNull();
    expect(parseAddress(undefined)).toBeNull();
  });

  it('splits References into individual message ids', () => {
    expect(parseReferences('<a@x> <b@x>\n <c@x>')).toEqual(['<a@x>', '<b@x>', '<c@x>']);
    expect(parseReferences(undefined)).toEqual([]);
  });
});

describe('quoted text', () => {
  it('keeps the reply and drops the history', () => {
    const body = [
      'Still broken for me.',
      '',
      'On Tue, 12 May 2026 at 10:02, Support <support@example.com> wrote:',
      '> Could you try again?',
      '> Thanks',
    ].join('\n');
    expect(stripQuotedText(body)).toBe('Still broken for me.');
  });

  it('never strips a message down to nothing', () => {
    const onlyQuote = 'On Tue, 12 May 2026 at 10:02, Support wrote:\n> anything';
    expect(stripQuotedText(onlyQuote)).toBe(onlyQuote.trim());
  });
});

describe('automated mail detection', () => {
  it('recognises the usual machine senders', () => {
    expect(looksAutomated({ 'auto-submitted': 'auto-replied' })).toBe(true);
    expect(looksAutomated({ precedence: 'bulk' })).toBe(true);
    expect(looksAutomated({ from: 'MAILER-DAEMON@example.com' })).toBe(true);
    expect(looksAutomated({ 'return-path': '<>' })).toBe(true);
    expect(looksAutomated({ from: 'rhea@example.com', 'auto-submitted': 'no' })).toBe(false);
  });
});

describe('subject ticket reference', () => {
  it('finds the ticket number a mail client carried back', () => {
    expect(ticketNumberFromSubject('Re: [#1042] Cannot log in')).toBe(1042);
    expect(ticketNumberFromSubject('No reference here')).toBeNull();
  });
});

describe('generic email provider', () => {
  const payload = {
    messageId: '<abc@mail.example.com>',
    from: '"Rhea Kapoor" <rhea@example.com>',
    to: 'support@example.com',
    subject: 'Re: [#7] Export crashes',
    text: 'It still crashes.\n\nOn Tue, Support wrote:\n> Have you tried again?',
    inReplyTo: '<previous@mail.example.com>',
    references: '<first@mail.example.com> <previous@mail.example.com>',
    headers: { 'Auto-Submitted': 'no' },
    attachments: [{ fileName: 'log.txt', mimeType: 'text/plain', contentBase64: 'aGk=' }],
  };

  it('accepts an unsigned payload when no secret is configured', () => {
    expect(
      genericEmailProvider.verify({ rawBody: '{}', headers: {}, query: {} }, {}),
    ).toBe(true);
  });

  it('requires a matching signature once a secret exists', () => {
    const rawBody = JSON.stringify(payload);
    const signature = createHmac('sha256', 'shh').update(rawBody).digest('hex');
    const secrets = { signingSecret: 'shh' };

    expect(
      genericEmailProvider.verify({ rawBody, headers: { 'x-digisoft-signature': signature }, query: {} }, secrets),
    ).toBe(true);
    expect(
      genericEmailProvider.verify({ rawBody, headers: { 'x-digisoft-signature': 'nope' }, query: {} }, secrets),
    ).toBe(false);
    expect(genericEmailProvider.verify({ rawBody, headers: {}, query: {} }, secrets)).toBe(false);
  });

  it('maps a reply into an inbound message', () => {
    const [message] = genericEmailProvider.parse(payload, context);
    expect(message).toMatchObject({
      externalId: '<abc@mail.example.com>',
      from: { externalId: 'rhea@example.com', name: 'Rhea Kapoor', email: 'rhea@example.com' },
      to: 'support@example.com',
      subject: 'Re: [#7] Export crashes',
      text: 'It still crashes.',
      inReplyTo: '<previous@mail.example.com>',
      isAutomated: false,
    });
    expect(message?.references).toEqual(['<first@mail.example.com>', '<previous@mail.example.com>']);
    expect(message?.attachments).toHaveLength(1);
  });

  it('keeps the quoted history when the channel asks it to', () => {
    const [message] = genericEmailProvider.parse(payload, {
      identifier: null,
      config: { stripQuotedText: false },
    });
    expect(message?.text).toContain('Have you tried again?');
  });

  it('drops a payload with no usable sender', () => {
    expect(genericEmailProvider.parse({ text: 'orphan' }, context)).toEqual([]);
  });
});

describe('mailgun provider', () => {
  const signingKey = 'mailgun-signing-key';
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const token = 'token-value';
  const signature = createHmac('sha256', signingKey).update(`${timestamp}${token}`).digest('hex');

  const body = {
    signature: { timestamp, token, signature },
    'Message-Id': '<mg-1@example.com>',
    from: 'Rhea <rhea@example.com>',
    recipient: 'support@example.com',
    subject: 'Help please',
    'stripped-text': 'Nothing loads.',
    headers: { 'Message-Id': '<mg-1@example.com>' },
  };

  it('verifies the signature and refuses a stale one', () => {
    expect(
      mailgunEmailProvider.verify({ rawBody: JSON.stringify(body), headers: {}, query: {} }, { signingKey }),
    ).toBe(true);

    const stale = { ...body, signature: { ...body.signature, timestamp: '1000000' } };
    expect(
      mailgunEmailProvider.verify({ rawBody: JSON.stringify(stale), headers: {}, query: {} }, { signingKey }),
    ).toBe(false);
    expect(
      mailgunEmailProvider.verify({ rawBody: 'not json', headers: {}, query: {} }, { signingKey }),
    ).toBe(false);
  });

  it('verifies a form-encoded route post', () => {
    const form = new URLSearchParams({
      timestamp,
      token,
      signature,
      sender: 'rhea@example.com',
      'body-plain': 'Nothing loads.',
    }).toString();
    const headers = { 'content-type': 'application/x-www-form-urlencoded' };
    expect(mailgunEmailProvider.verify({ rawBody: form, headers, query: {} }, { signingKey })).toBe(true);
    expect(
      mailgunEmailProvider.verify(
        { rawBody: form.replace(signature, 'forged'), headers, query: {} },
        { signingKey },
      ),
    ).toBe(false);
  });

  it('maps form fields, JSON-encoded headers and attachments', () => {
    const [message] = mailgunEmailProvider.parse(
      {
        from: 'Rhea <rhea@example.com>',
        recipient: 'support@example.com',
        subject: 'Help please',
        'body-plain': 'Nothing loads.',
        'message-headers': JSON.stringify([
          ['Message-Id', '<mg-2@example.com>'],
          ['In-Reply-To', '<prev@example.com>'],
        ]),
        attachments: JSON.stringify([
          { url: 'https://storage.mailgun.net/v3/x', 'content-type': 'image/png', name: 'a.png' },
        ]),
      },
      context,
    );
    expect(message).toMatchObject({
      externalId: '<mg-2@example.com>',
      inReplyTo: '<prev@example.com>',
      attachments: [{ fileName: 'a.png', mimeType: 'image/png', url: 'https://storage.mailgun.net/v3/x' }],
    });
  });

  it('maps the payload', () => {
    const [message] = mailgunEmailProvider.parse(body, context);
    expect(message).toMatchObject({
      externalId: '<mg-1@example.com>',
      from: { externalId: 'rhea@example.com', name: 'Rhea' },
      subject: 'Help please',
      text: 'Nothing loads.',
    });
  });
});

describe('postmark provider', () => {
  const secrets = { webhookUsername: 'hook', webhookPassword: 'secret' };
  const authorization = `Basic ${Buffer.from('hook:secret').toString('base64')}`;

  it('checks the basic credentials when they are configured', () => {
    expect(postmarkEmailProvider.verify({ rawBody: '{}', headers: { authorization }, query: {} }, secrets)).toBe(true);
    expect(postmarkEmailProvider.verify({ rawBody: '{}', headers: {}, query: {} }, secrets)).toBe(false);
    expect(postmarkEmailProvider.verify({ rawBody: '{}', headers: {}, query: {} }, {})).toBe(true);
  });

  it('maps the payload and its headers', () => {
    const [message] = postmarkEmailProvider.parse(
      {
        MessageID: 'pm-1',
        FromFull: { Name: 'Rhea Kapoor', Email: 'rhea@example.com' },
        OriginalRecipient: 'support@example.com',
        Subject: 'Re: [#12] Billing',
        TextBody: 'Any update?',
        Headers: [{ Name: 'In-Reply-To', Value: '<prev@example.com>' }],
      },
      context,
    );
    expect(message).toMatchObject({
      externalId: 'pm-1',
      from: { externalId: 'rhea@example.com', name: 'Rhea Kapoor' },
      text: 'Any update?',
      inReplyTo: '<prev@example.com>',
    });
  });
});
