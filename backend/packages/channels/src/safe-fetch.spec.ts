import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isPrivateAddress, isPublicHttpUrl } from '@digisoft/shared';
import {
  assertSafeUrl,
  guardedLookup,
  ResponseTooLargeError,
  safeFetch,
  UnsafeUrlError,
} from './safe-fetch';

describe('address classification', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.5',
    '172.16.3.4',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '[::1]',
    'fd12:3456::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:a9fe:a9fe',
    '64:ff9b::a00:1',
    '2002:0a00:0001::1',
  ])('refuses %s', (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])(
    'allows public %s',
    (address) => {
      expect(isPrivateAddress(address)).toBe(false);
    },
  );

  it('treats anything unparseable as blocked', () => {
    expect(isPrivateAddress('not-an-ip')).toBe(true);
  });

  it('screens obvious internal webhook URLs without resolving them', () => {
    expect(isPublicHttpUrl('https://hooks.example.com/in')).toBe(true);
    expect(isPublicHttpUrl('http://localhost:8080/')).toBe(false);
    expect(isPublicHttpUrl('http://2130706433/')).toBe(false); // 127.0.0.1 in decimal
    expect(isPublicHttpUrl('http://[::ffff:127.0.0.1]/')).toBe(false);
    expect(isPublicHttpUrl('http://metadata.google.internal/')).toBe(false);
    expect(isPublicHttpUrl('ftp://example.com/')).toBe(false);
  });
});

describe('assertSafeUrl', () => {
  it('refuses non-http schemes, credentials and internal literals', () => {
    expect(() => assertSafeUrl('file:///etc/passwd')).toThrow(UnsafeUrlError);
    expect(() => assertSafeUrl('http://user:pw@example.com/')).toThrow(UnsafeUrlError);
    expect(() => assertSafeUrl('http://169.254.169.254/latest/meta-data')).toThrow(UnsafeUrlError);
    expect(() => assertSafeUrl('http://localhost./')).toThrow(UnsafeUrlError);
    expect(() => assertSafeUrl('http://[::1]:4000/')).toThrow(UnsafeUrlError);
    expect(assertSafeUrl('https://example.com/a').hostname).toBe('example.com');
  });
});

describe('guardedLookup', () => {
  it('refuses a name that resolves to loopback', async () => {
    const lookup = guardedLookup(isPrivateAddress);
    const error = await new Promise<Error | null>((resolve) => {
      lookup('localhost', {}, (err) => resolve(err));
    });
    expect(error).toBeInstanceOf(UnsafeUrlError);
  });
});

describe('safeFetch', () => {
  let server: Server;
  let base: string;
  const big = Buffer.alloc(64 * 1024, 'a');

  // The test server lives on loopback, so these tests loosen the policy to allow
  // 127.0.0.1 specifically while still refusing every other internal range.
  const allowLoopback = (address: string) => address !== '127.0.0.1' && isPrivateAddress(address);

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/ok') {
        res.end('hello');
      } else if (req.url === '/big') {
        res.end(big);
      } else if (req.url === '/redirect-internal') {
        res.writeHead(302, { location: 'http://10.255.255.1/secret' });
        res.end();
      } else if (req.url === '/redirect-ok') {
        res.writeHead(302, { location: '/ok' });
        res.end();
      } else if (req.url === '/loop') {
        res.writeHead(302, { location: '/loop' });
        res.end();
      } else if (req.url === '/slow') {
        const timer = setTimeout(() => res.end('late'), 2000);
        res.on('close', () => clearTimeout(timer));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('refuses loopback under the default policy', async () => {
    await expect(safeFetch(`${base}/ok`)).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it('fetches an allowed target', async () => {
    const response = await safeFetch(`${base}/ok`, { isBlockedAddress: allowLoopback });
    expect(response.ok).toBe(true);
    expect(response.body.toString()).toBe('hello');
  });

  it('re-checks every redirect hop', async () => {
    await expect(
      safeFetch(`${base}/redirect-internal`, { isBlockedAddress: allowLoopback }),
    ).rejects.toBeInstanceOf(UnsafeUrlError);

    const followed = await safeFetch(`${base}/redirect-ok`, { isBlockedAddress: allowLoopback });
    expect(followed.body.toString()).toBe('hello');
    expect(followed.url).toBe(`${base}/ok`);
  });

  it('caps redirects', async () => {
    await expect(
      safeFetch(`${base}/loop`, { isBlockedAddress: allowLoopback, maxRedirects: 2 }),
    ).rejects.toThrow(/Too many redirects/);
  });

  it('does not follow redirects for POST', async () => {
    const response = await safeFetch(`${base}/redirect-ok`, {
      method: 'POST',
      body: '{}',
      isBlockedAddress: allowLoopback,
    });
    expect(response.status).toBe(302);
  });

  it('caps the body while streaming', async () => {
    await expect(
      safeFetch(`${base}/big`, { isBlockedAddress: allowLoopback, maxBytes: 1024 }),
    ).rejects.toBeInstanceOf(ResponseTooLargeError);

    const truncated = await safeFetch(`${base}/big`, {
      isBlockedAddress: allowLoopback,
      maxBytes: 1024,
      onOverflow: 'truncate',
    });
    expect(truncated.body.length).toBe(1024);
    expect(truncated.truncated).toBe(true);
  });

  it('gives up at the deadline', async () => {
    await expect(
      safeFetch(`${base}/slow`, { isBlockedAddress: allowLoopback, timeoutMs: 200 }),
    ).rejects.toThrow(/timed out/);
  });
});
