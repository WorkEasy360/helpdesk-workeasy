import { DEFAULT_NEXT, safeNext } from './safe-next';

describe('safeNext', () => {
  it('keeps a same-site path, with its query and fragment', () => {
    expect(safeNext('/tickets')).toBe('/tickets');
    expect(safeNext('/tickets/abc123?tab=notes#reply')).toBe('/tickets/abc123?tab=notes#reply');
    expect(safeNext('/settings/users?page=2&q=ann')).toBe('/settings/users?page=2&q=ann');
  });

  it.each([
    ['nothing', undefined],
    ['null', null],
    ['a number', 12],
    ['an array', ['/a', '/b']],
    ['an object', { 0: '/a' }],
    ['an empty string', ''],
  ])('falls back to the dashboard for %s', (_name, value) => {
    expect(safeNext(value)).toBe(DEFAULT_NEXT);
  });

  it.each([
    ['a protocol-relative URL', '//evil.example'],
    ['a protocol-relative URL with a path', '//evil.example/dashboard'],
    ['a backslash after the slash', '/' + String.fromCharCode(92) + 'evil.example'],
    ['a backslash anywhere', '/ok' + String.fromCharCode(92) + 'evil'],
    ['a tab (a browser strips it, leaving //evil)', '/\t/evil.example'],
    ['a newline', '/\n/evil.example'],
    ['a carriage return', '/\r/evil.example'],
    ['a space', '/ /evil.example'],
    ['a NUL', '/' + String.fromCharCode(0) + '/evil.example'],
    ['a DEL', '/' + String.fromCharCode(0x7f) + '/evil.example'],
    ['a next-line control (C1)', '/' + String.fromCharCode(0x85) + '/evil.example'],
    ['a no-break space', '/' + String.fromCharCode(0xa0) + '/evil.example'],
    ['a line separator', '/' + String.fromCharCode(0x2028) + '/evil.example'],
    ['an ideographic space', '/' + String.fromCharCode(0x3000) + '/evil.example'],
    ['an absolute https URL', 'https://evil.example/'],
    ['an absolute http URL', 'http://evil.example/'],
    ['a scheme-relative URL without slashes', 'evil.example/path'],
    ['a javascript URL', 'javascript:alert(1)'],
    ['a data URL', 'data:text/html,<script>alert(1)</script>'],
    ['a path that does not start with a slash', 'dashboard'],
    ['an over-long path', '/' + 'a'.repeat(2048)],
  ])('refuses %s', (_name, value) => {
    expect(safeNext(value)).toBe(DEFAULT_NEXT);
  });

  it('refuses the sign-in pages and the API, which would bounce straight back or leave the app', () => {
    for (const path of [
      '/login',
      '/login?next=/tickets',
      '/register',
      '/forgot-password',
      '/reset-password?token=x',
      '/verify-email',
      '/access-ended',
      '/access-ended?reason=expired',
      '/api/auth/workeasy360/start',
      '/api/v1/tickets',
      '/api',
    ]) {
      expect(safeNext(path)).toBe(DEFAULT_NEXT);
    }
  });

  it('does not mistake a longer first segment for an auth page', () => {
    expect(safeNext('/loginhelp')).toBe('/loginhelp');
    expect(safeNext('/registers')).toBe('/registers');
  });

  it('keeps percent-encoded forms inside the site: the browser does not decode them into a host', () => {
    for (const value of ['/%2F%2Fevil.example', '/%5Cevil.example', '/%09/evil.example', '/%0d%0aLocation:%20https://evil.example']) {
      const result = safeNext(value);
      const resolved = new URL(result, 'http://same-site.invalid');
      expect(resolved.origin).toBe('http://same-site.invalid');
      expect(result.startsWith('//')).toBe(false);
    }
  });

  it('drops a launcher query so landing does not start another sign-in', () => {
    expect(safeNext('/tickets?organization=3f1f6a3e-1f0e-4d6a-9c50-4c0a1c1e0b11')).toBe('/tickets');
    expect(safeNext('/?organization=3f1f6a3e-1f0e-4d6a-9c50-4c0a1c1e0b11')).toBe(DEFAULT_NEXT);
  });

  it('never returns anything that resolves off-site, whatever it is given', () => {
    const attempts = [
      '/..//evil.example',
      '/./\\evil.example',
      '/.//evil.example',
      '///evil.example',
      '/////evil.example',
      '/?next=//evil.example',
      '/#//evil.example',
    ];
    for (const value of attempts) {
      const result = safeNext(value);
      expect(new URL(result, 'http://same-site.invalid').origin).toBe('http://same-site.invalid');
      expect(result.startsWith('//')).toBe(false);
    }
  });
});
