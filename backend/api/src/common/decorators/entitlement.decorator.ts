import { SetMetadata } from '@nestjs/common';

export const ENTITLEMENT_EXEMPT_KEY = 'digisoft:entitlementExempt';
export const ENTITLEMENT_READ_KEY = 'digisoft:entitlementRead';

/**
 * Stays reachable after Workeasy360 access ended, so a person can see why and sign out
 * (`/auth/me`). Public routes are never checked and need no marker.
 */
export const EntitlementExempt = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ENTITLEMENT_EXEMPT_KEY, true);

/**
 * A route that only reads but answers POST (a search, a preview). While an organization is
 * read-only it stays available, like a GET.
 */
export const EntitlementRead = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ENTITLEMENT_READ_KEY, true);
