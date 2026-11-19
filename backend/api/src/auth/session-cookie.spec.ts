import type { Request, Response } from 'express';
import type { AppConfig } from '../config/config.module';
import {
  HOST_REFRESH_COOKIE,
  REFRESH_COOKIE,
  clearRefreshCookie,
  readRefreshCookie,
  refreshCookieName,
  setRefreshCookie,
} from './session-cookie';

interface Written {
  kind: 'set' | 'clear';
  name: string;
  value?: string;
  options: Record<string, unknown>;
}

function config(values: { COOKIE_SECURE: boolean; COOKIE_DOMAIN?: string }): AppConfig {
  const all: Record<string, unknown> = { API_PREFIX: 'api/v1', COOKIE_DOMAIN: undefined, ...values };
  return { get: (key: string) => all[key] } as unknown as AppConfig;
}

function recorder(): { res: Response; written: Written[] } {
  const written: Written[] = [];
  const res = {
    cookie: (name: string, value: string, options: Record<string, unknown>) => {
      written.push({ kind: 'set', name, value, options });
    },
    clearCookie: (name: string, options: Record<string, unknown>) => {
      written.push({ kind: 'clear', name, options });
    },
  } as unknown as Response;
  return { res, written };
}

const request = (cookies: Record<string, string>): Request => ({ cookies }) as unknown as Request;
const inTenMinutes = (): Date => new Date(Date.now() + 10 * 60_000);

describe('the agent refresh cookie over plain http (development, tests)', () => {
  const http = config({ COOKIE_SECURE: false, COOKIE_DOMAIN: '.example.test' });

  it('keeps today\'s name and attributes: ds_refresh, httpOnly, SameSite=Lax, Path=/api, with the configured domain', () => {
    const { res, written } = recorder();
    setRefreshCookie(res, http, 'token-1', inTenMinutes());
    const live = written.find((w) => w.kind === 'set')!;
    expect(live.name).toBe('ds_refresh');
    expect(live.options).toMatchObject({ httpOnly: true, secure: false, sameSite: 'lax', path: '/api', domain: '.example.test' });
    // The pre-Workeasy360 path is expired alongside, and nothing else.
    const cleared = written.filter((w) => w.kind === 'clear');
    expect(cleared.map((w) => [w.name, w.options['path']])).toEqual([['ds_refresh', '/api/v1/auth']]);
  });

  it('reads only ds_refresh, and ignores the __Host- name', () => {
    expect(refreshCookieName(http)).toBe(REFRESH_COOKIE);
    expect(readRefreshCookie(request({ ds_refresh: 'abc' }), http)).toBe('abc');
    expect(readRefreshCookie(request({ [HOST_REFRESH_COOKIE]: 'abc' }), http)).toBeUndefined();
    expect(readRefreshCookie(request({ ds_refresh: '' }), http)).toBeUndefined();
    expect(readRefreshCookie({} as Request, http)).toBeUndefined();
  });

  it('clears the live cookie at its own path and the legacy one', () => {
    const { res, written } = recorder();
    clearRefreshCookie(res, http);
    expect(written.every((w) => w.kind === 'clear' && w.name === 'ds_refresh')).toBe(true);
    expect(written.map((w) => w.options['path'])).toEqual(['/api', '/api/v1/auth']);
  });
});

describe('the agent refresh cookie with Secure cookies (production)', () => {
  const secure = config({ COOKIE_SECURE: true, COOKIE_DOMAIN: '.example.test' });

  it('is __Host-ds_refresh: Secure, httpOnly, SameSite=Lax, Path=/, and never a Domain, even when COOKIE_DOMAIN is set', () => {
    const { res, written } = recorder();
    setRefreshCookie(res, secure, 'token-1', inTenMinutes());
    const live = written.find((w) => w.kind === 'set')!;
    expect(live.name).toBe('__Host-ds_refresh');
    expect(live.value).toBe('token-1');
    expect(live.options).toMatchObject({ httpOnly: true, secure: true, sameSite: 'lax', path: '/' });
    expect(live.options).not.toHaveProperty('domain');
    expect(Number(live.options['maxAge'])).toBeGreaterThan(0);
  });

  it('expires what earlier releases left behind: the unprefixed cookie at /api and at the legacy path, with its domain', () => {
    const { res, written } = recorder();
    setRefreshCookie(res, secure, 'token-1', inTenMinutes());
    const cleared = written.filter((w) => w.kind === 'clear');
    expect(cleared.map((w) => [w.name, w.options['path']])).toEqual([
      ['ds_refresh', '/api/v1/auth'],
      ['ds_refresh', '/api'],
    ]);
    expect(cleared.every((w) => w.options['domain'] === '.example.test')).toBe(true);
  });

  it('clears the live cookie with the attributes that make a browser accept it (Path=/, Secure, no Domain)', () => {
    const { res, written } = recorder();
    clearRefreshCookie(res, secure);
    const live = written.find((w) => w.name === '__Host-ds_refresh')!;
    expect(live.kind).toBe('clear');
    expect(live.options).toMatchObject({ secure: true, path: '/' });
    expect(live.options).not.toHaveProperty('domain');
  });

  it('reads ONLY the __Host- name: an unprefixed ds_refresh (planted by a sibling subdomain) is never used', () => {
    expect(refreshCookieName(secure)).toBe('__Host-ds_refresh');
    expect(readRefreshCookie(request({ [HOST_REFRESH_COOKIE]: 'mine' }), secure)).toBe('mine');
    expect(readRefreshCookie(request({ ds_refresh: 'planted' }), secure)).toBeUndefined();
    // Both present: the prefixed one wins, whatever order the parser saw them in.
    expect(readRefreshCookie(request({ ds_refresh: 'planted', [HOST_REFRESH_COOKIE]: 'mine' }), secure)).toBe('mine');
    expect(readRefreshCookie(request({ [HOST_REFRESH_COOKIE]: 'mine', ds_refresh: 'planted' }), secure)).toBe('mine');
  });
});
