'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { AuthMethods } from '@digisoft/shared';
import { refreshSession } from '@/lib/api-client';
import { beginAutoStart, clearLoopGuard } from '@/lib/auto-sign-in';
import { authService } from '@/services/auth.service';
import { useAuthStore } from '@/stores/auth.store';
import { authMethodsQuery } from '@/hooks/use-auth-methods';

export type SessionStatus = 'loading' | 'authenticated' | 'anonymous' | 'signing-in';

/**
 * Opening an agent app page with no session at all, on an SSO-only deployment, starts the
 * Workeasy360 sign-in right away instead of showing the sign-in page (integration guide 6b).
 * Returns the start URL to navigate to, or null when the sign-in page should be shown:
 * not SSO-only (or `/auth/methods` unreadable), the person signed out here, or this browser
 * started automatically a moment ago. See `lib/auto-sign-in.ts`.
 */
async function autoStartUrl(queryClient: QueryClient): Promise<string | null> {
  let methods: AuthMethods | null = null;
  try {
    methods = await queryClient.fetchQuery(authMethodsQuery);
  } catch {
    // Unreadable: the sign-in page offers the choice, like everywhere else.
  }
  const decision = beginAutoStart({
    methods,
    page: `${window.location.pathname}${window.location.search}`,
  });
  return decision.start ? decision.url : null;
}

/**
 * Restores a session on first paint by exchanging the http-only refresh cookie for a
 * fresh access token. Returns 'loading' until that round trip settles.
 *
 * Only an answer of "no session at all" (the refresh says 401) may start a Workeasy360
 * sign-in by itself, and only on a page load: a session that exists but must sign in again
 * (`WORKEASY360_SIGN_IN_REQUIRED`), one whose access ended (`/access-ended`), or a refresh
 * that could not be answered keeps today's behaviour. Nothing here replaces a session silently.
 */
export function useSessionBootstrap(): SessionStatus {
  const status = useAuthStore((state) => state.status);
  const setUser = useAuthStore((state) => state.setUser);
  const queryClient = useQueryClient();
  const [signingIn, setSigningIn] = useState(false);

  useEffect(() => {
    if (status !== 'loading') {
      return;
    }
    let cancelled = false;

    void (async () => {
      const outcome = await refreshSession({ portalSlug: null });
      if (cancelled) return;
      if (outcome.kind !== 'ok') {
        if (outcome.kind === 'no_session') {
          const url = await autoStartUrl(queryClient);
          if (cancelled) return;
          if (url) {
            setSigningIn(true);
            // Replace, not assign: the page that needs a session is not worth going Back to.
            window.location.replace(url);
            return;
          }
        }
        setUser(null);
        return;
      }
      try {
        const user = await authService.me();
        if (!cancelled) {
          // A session exists, so there is no loop left to guard against. The signed-out marker is
          // NOT touched: a refresh that succeeded is not a sign-in (another tab may be signing
          // out right now); only the Workeasy360 callback and the password form clear it.
          clearLoopGuard();
          setUser(user);
        }
      } catch {
        if (!cancelled) setUser(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [status, setUser, queryClient]);

  return signingIn && status === 'loading' ? 'signing-in' : status;
}

/**
 * Sends anonymous visitors to the login page once the bootstrap has settled, carrying
 * the page they asked for so sign-in can return them to it.
 */
export function useRequireAuth(): 'loading' | 'authenticated' | 'signing-in' {
  const status = useSessionBootstrap();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (status === 'anonymous') {
      // Read at redirect time so the query string (filters, tabs) survives as well.
      const current =
        typeof window === 'undefined' ? pathname : `${window.location.pathname}${window.location.search}`;
      const next = current && current !== '/' && current !== '/login' ? `?next=${encodeURIComponent(current)}` : '';
      router.replace(`/login${next}`);
    }
  }, [status, router, pathname]);

  if (status === 'authenticated') return 'authenticated';
  return status === 'signing-in' ? 'signing-in' : 'loading';
}
