import pino from 'pino';
import { Writable } from 'node:stream';
import { Logger } from '@nestjs/common';
import { AllExceptionsFilter } from '../filters/all-exceptions.filter';
import { LOG_REDACT_PATHS } from './redact';

describe('what the request logger keeps out of the log', () => {
  it('removes the Location header of a redirect (the sign-in redirects carry state and nonce)', () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    const logger = pino({ redact: { paths: LOG_REDACT_PATHS, remove: true } }, sink);
    logger.info({
      res: { statusCode: 302, headers: { location: 'https://auth.example/authorize?state=SECRETSTATE&nonce=SECRETNONCE', 'set-cookie': ['a=b'] } },
      req: { headers: { cookie: 'x=y', authorization: 'Bearer z' } },
    });
    const logged = lines.join('');
    expect(logged).not.toContain('SECRETSTATE');
    expect(logged).not.toContain('SECRETNONCE');
    expect(logged).not.toContain('Bearer');
    expect(logged).toContain('302');
  });

  it('logs a 5xx without the query string of the request', () => {
    const messages: string[] = [];
    const spy = jest.spyOn(Logger.prototype, 'error').mockImplementation((message: unknown) => {
      messages.push(String(message));
    });
    try {
      const filter = new AllExceptionsFilter(true);
      const response = { status: () => ({ json: () => undefined }) };
      const request = { method: 'GET', url: '/api/auth/callback/workeasy360?code=SECRETCODE&state=SECRETSTATE', originalUrl: '/api/auth/callback/workeasy360?code=SECRETCODE&state=SECRETSTATE' };
      filter.catch(new Error('boom'), {
        switchToHttp: () => ({ getResponse: () => response, getRequest: () => request }),
      } as never);
    } finally {
      spy.mockRestore();
    }
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('/api/auth/callback/workeasy360');
    expect(messages[0]).not.toContain('SECRETCODE');
    expect(messages[0]).not.toContain('SECRETSTATE');
  });
});
