'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { refreshAccessToken } from '@/lib/api-client';
import { authService } from '@/services/auth.service';
import { useAuthStore } from '@/stores/auth.store';

/**
 * Restores a session on first paint by exchanging the http-only refresh cookie for a
 * fresh access token. Returns 'loading' until that round trip settles.
 */
export function useSessionBootstrap(): 'loading' | 'authenticated' | 'anonymous' {
  const status = useAuthStore((state) => state.status);
  const setUser = useAuthStore((state) => state.setUser);

  useEffect(() => {
    if (status !== 'loading') {
      return;
    }
    let cancelled = false;

    void (async () => {
      const token = await refreshAccessToken({ portalSlug: null });
      if (cancelled) return;
      if (!token) {
        setUser(null);
        return;
      }
      try {
        const user = await authService.me();
        if (!cancelled) setUser(user);
      } catch {
        if (!cancelled) setUser(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [status, setUser]);

  return status;
}

/**
 * Sends anonymous visitors to the login page once the bootstrap has settled, carrying
 * the page they asked for so sign-in can return them to it.
 */
export function useRequireAuth(): 'loading' | 'authenticated' {
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

  return status === 'authenticated' ? 'authenticated' : 'loading';
}
