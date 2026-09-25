import { Readable } from 'node:stream';
import type { Request, Response } from 'express';
import { sendAttachmentDownload, wantsDownloadLink } from './attachment-download';

function fakeRequest(query: Record<string, string> = {}, accept?: string): Request {
  return {
    query,
    headers: accept ? { accept } : {},
    originalUrl: '/api/v1/attachments/att_1/download?mode=url',
  } as unknown as Request;
}

function fakeResponse() {
  const res = {
    headers: {} as Record<string, unknown>,
    statusCode: 200,
    body: undefined as unknown,
    redirectedTo: undefined as string | undefined,
    setHeader(name: string, value: unknown) {
      res.headers[name.toLowerCase()] = value;
    },
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
    redirect(code: number, url: string) {
      res.statusCode = code;
      res.redirectedTo = url;
    },
  };
  return res;
}

const file = { fileName: 'report.pdf', mimeType: 'application/pdf', fileSize: 2048 };

describe('attachment download responses', () => {
  it('only switches to JSON on an explicit request', () => {
    expect(wantsDownloadLink(fakeRequest({ mode: 'url' }))).toBe(true);
    expect(wantsDownloadLink(fakeRequest({}, 'application/json'))).toBe(true);
    expect(wantsDownloadLink(fakeRequest({}, 'text/html,application/xhtml+xml,*/*;q=0.8'))).toBe(false);
    expect(wantsDownloadLink(fakeRequest({ mode: 'stream' }))).toBe(false);
  });

  it('returns the signed URL and its expiry for object storage', () => {
    const res = fakeResponse();
    const expiresAt = new Date('2026-09-25T12:05:00.000Z');
    sendAttachmentDownload(fakeRequest({ mode: 'url' }), res as unknown as Response, {
      ...file,
      target: { url: 'https://bucket.example/obj?X-Amz-Signature=abc', expiresAt },
    });

    expect(res.redirectedTo).toBeUndefined();
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      success: true,
      data: {
        url: 'https://bucket.example/obj?X-Amz-Signature=abc',
        ...file,
        expiresAt: '2026-09-25T12:05:00.000Z',
        direct: true,
      },
    });
  });

  it('points at the streaming route for local storage and releases the unread stream', () => {
    const res = fakeResponse();
    const stream = Readable.from(['bytes']);
    sendAttachmentDownload(fakeRequest({ mode: 'url' }), res as unknown as Response, {
      ...file,
      target: { stream },
    });

    expect(stream.destroyed).toBe(true);
    expect(res.body).toMatchObject({
      data: { url: '/api/v1/attachments/att_1/download', expiresAt: null, direct: false },
    });
  });

  it('still redirects by default', () => {
    const res = fakeResponse();
    sendAttachmentDownload(fakeRequest(), res as unknown as Response, {
      ...file,
      target: { url: 'https://bucket.example/obj' },
    });
    expect(res.statusCode).toBe(302);
    expect(res.redirectedTo).toBe('https://bucket.example/obj');
  });
});
