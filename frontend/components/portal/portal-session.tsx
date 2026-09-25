'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { refreshAccessToken, setAccessToken, setPortalSession } from '@/lib/api-client';
import { portalService } from '@/services/portal.service';
import type { PortalProfile } from '@/types/api';

interface PortalSession {
  slug: string;
  profile: PortalProfile | null;
  status: 'loading' | 'signed-in' | 'anonymous';
  signedIn: (accessToken: string) => Promise<void>;
  signOut: () => Promise<void>;
  reload: () => Promise<void>;
}

const PortalSessionContext = createContext<PortalSession | null>(null);

/**
 * Restores a customer session from this help center's own http-only refresh cookie
 * (`ds_portal_refresh`, renewed at `/portal/:slug/auth/refresh`), then keeps the profile
 * in memory. It never touches the agent app's session cookie, and the access token is
 * never persisted.
 */
export function PortalSessionProvider({ slug, children }: { slug: string; children: React.ReactNode }) {
  const [profile, setProfile] = useState<PortalProfile | null>(null);
  const [status, setStatus] = useState<'loading' | 'signed-in' | 'anonymous'>('loading');
  const statusRef = useRef(status);
  statusRef.current = status;
  const queryClient = useQueryClient();

  const load = useCallback(async () => {
    try {
      const me = await portalService(slug).me();
      setProfile(me);
      setStatus('signed-in');
    } catch {
      setProfile(null);
      setStatus('anonymous');
    }
  }, [slug]);

  // Drops everything fetched as this customer. Only the public site configuration is
  // kept, so the shell does not flash.
  const forget = useCallback(() => {
    setAccessToken(null);
    setProfile(null);
    setStatus('anonymous');
    queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== 'portal-config' });
  }, [queryClient]);

  // Route this page's refreshes to the help center's auth routes, and hear about a
  // session that could not be renewed. Leaving the help center hands the page back.
  useEffect(() => {
    setPortalSession(slug, () => {
      if (statusRef.current === 'signed-in') forget();
    });
    return () => {
      setPortalSession(null);
      setAccessToken(null);
    };
  }, [slug, forget]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const token = await refreshAccessToken({ portalSlug: slug });
      if (cancelled) return;
      if (!token) {
        setStatus('anonymous');
        return;
      }
      await load();
    })();
    return () => {
      cancelled = true;
    };
  }, [slug, load]);

  const value = useMemo<PortalSession>(
    () => ({
      slug,
      profile,
      status,
      signedIn: async (accessToken: string) => {
        setAccessToken(accessToken);
        await load();
      },
      signOut: async () => {
        await portalService(slug).logout().catch(() => undefined);
        forget();
      },
      reload: load,
    }),
    [slug, profile, status, load, forget],
  );

  return <PortalSessionContext.Provider value={value}>{children}</PortalSessionContext.Provider>;
}

export function usePortalSession(): PortalSession {
  const session = useContext(PortalSessionContext);
  if (!session) {
    throw new Error('usePortalSession used outside the help center');
  }
  return session;
}
