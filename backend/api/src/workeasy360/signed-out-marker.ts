import type { Response } from 'express';

/**
 * The frontend's "signed out of Easy Help Desk in this browser" marker (`frontend/lib/auto-sign-in.ts`):
 * a session cookie both sign-outs write, which stops a page opened with no session from starting
 * a Workeasy360 sign-in by itself. A real sign-in is what ends it, and the Workeasy360 callback is
 * where a real sign-in is known for certain, so the callback expires it here (the frontend does the
 * same for the password form). A refresh that merely succeeded must not: another tab may be in
 * the middle of signing out.
 *
 * Over https (COOKIE_SECURE) the frontend names it `__Host-hd_signed_out` (Secure, Path=/, no
 * Domain); over http it is `hd_signed_out`. The frontend and the API share a host, behind the
 * reverse proxy in production and by host (ports do not scope cookies) in development.
 */
export const SIGNED_OUT_MARKER = 'hd_signed_out';
export const HOST_SIGNED_OUT_MARKER = `__Host-${SIGNED_OUT_MARKER}`;

/** Expires the marker in the browser that just signed in. Call only when the sign-in succeeded. */
export function clearSignedOutMarker(res: Response, secure: boolean): void {
  // Host-only on purpose: no `domain`, so exactly the cookie the frontend wrote is the one cleared.
  if (secure) {
    res.clearCookie(HOST_SIGNED_OUT_MARKER, { path: '/', secure: true, sameSite: 'lax' });
  }
  res.clearCookie(SIGNED_OUT_MARKER, { path: '/', secure: false, sameSite: 'lax' });
}
