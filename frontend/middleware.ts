import { NextResponse, type NextRequest } from 'next/server';

/**
 * The Workeasy360 launcher opens this app at `/?organization=<uuid>`. That always starts a
 * sign-in for that organization - even when a session already exists - because the person
 * just picked the organization in Workeasy360 (integration guide section 6a). The sign-in
 * itself is the API's: this only turns the launcher URL into the API's start URL.
 *
 * The sign-in page never starts one on its own; only a launcher URL does.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function apiOrigin(): string | null {
  // NEXT_PUBLIC_* values are inlined at build time, so this is referenced literally.
  const configured = process.env.NEXT_PUBLIC_API_URL?.trim();
  const value =
    configured || (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:4000/api/v1');
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function middleware(request: NextRequest) {
  const organization = request.nextUrl.searchParams.get('organization');
  // Anything that is not a UUID is not a launcher URL: the normal home page handles it.
  if (!organization || !UUID.test(organization)) return NextResponse.next();

  const origin = apiOrigin();
  if (!origin) return NextResponse.next();

  const start = new URL('/api/auth/workeasy360/start', origin);
  start.searchParams.set('organization', organization.toLowerCase());
  const response = NextResponse.redirect(start);
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

export const config = { matcher: ['/'] };
