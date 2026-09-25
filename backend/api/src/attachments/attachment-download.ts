import type { Request, Response } from 'express';
import type { AttachmentDownloadLink } from '@digisoft/shared';
import type { DownloadTarget } from '@digisoft/storage';
import { AppError } from '../common/errors/app-error';

export interface ResolvedDownload {
  target: DownloadTarget;
  fileName: string;
  mimeType: string;
  fileSize: number;
}

/**
 * A browser following a link cannot attach the bearer token, so a client that wants
 * the file asks for the link instead: `?mode=url`, or an explicit JSON Accept header.
 * Plain navigation (`Accept: text/html, …, *\/*`) keeps the redirect / stream.
 */
export function wantsDownloadLink(req: Request): boolean {
  if (req.query.mode === 'url') {
    return true;
  }
  return (req.headers.accept ?? '').toLowerCase().includes('application/json');
}

/**
 * Answers an authorised download the same way for the agent and portal routes: the
 * link as JSON when asked for, otherwise a redirect to object storage or the bytes
 * streamed from local storage.
 */
export function sendAttachmentDownload(req: Request, res: Response, download: ResolvedDownload): void {
  const { target, fileName, mimeType, fileSize } = download;

  if (wantsDownloadLink(req)) {
    // Local storage opened a stream this response will not read.
    target.stream?.destroy();
    const link: AttachmentDownloadLink = {
      url: target.url ?? req.originalUrl.split('?')[0]!,
      fileName,
      mimeType,
      fileSize,
      expiresAt: target.url ? (target.expiresAt?.toISOString() ?? null) : null,
      direct: Boolean(target.url),
    };
    // A signed URL is a bearer credential for the file; keep it out of shared caches.
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ success: true, data: link });
    return;
  }

  if (target.url) {
    res.redirect(302, target.url);
    return;
  }
  if (!target.stream) {
    throw AppError.notFound('attachment');
  }

  res.setHeader('Content-Type', mimeType);
  res.setHeader('Content-Length', fileSize);
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
  // Stops a stored SVG or HTML file from executing in the product's own origin.
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // A file missing from storage must fail this request, not the process.
  target.stream.on('error', () => {
    if (!res.headersSent) res.status(500);
    res.end();
  });
  target.stream.pipe(res);
}
