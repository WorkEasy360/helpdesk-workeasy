'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { authService } from '@/services/auth.service';
import { useAuthStore } from '@/stores/auth.store';
import { workeasy360LogoutUrl } from '@/lib/sso';
import { useAuthMethods } from '@/hooks/use-auth-methods';

export const SIGN_OUT_FAILED = 'Could not sign you out. Check your connection and try again.';

/**
 * "Sign out" ends this app's session only. "Sign out of Easy Help Desk and Workeasy360" ends it
 * first, then navigates to the API's sign-out route, which sends the browser on to
 * Workeasy360's own sign-out confirmation (and back to the sign-in page afterwards).
 *
 * The session is ended on the server (the refresh token family is revoked). If that request
 * fails - twice - nothing is cleared and nobody is sent anywhere: the person is told, and is
 * still signed in, rather than looking signed out while the session lives on.
 */
export function useSignOut() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const clear = useAuthStore((state) => state.clear);
  const { methods } = useAuthMethods();
  const [error, setError] = useState<string | null>(null);

  /** True once the server ended the session. */
  const endSession = async (): Promise<boolean> => {
    setError(null);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await authService.logout();
        clear();
        // Drop every cached response so the next person on this browser sees nothing of ours.
        queryClient.clear();
        return true;
      } catch {
        // One more try, then say so.
      }
    }
    setError(SIGN_OUT_FAILED);
    toast.error(SIGN_OUT_FAILED);
    return false;
  };

  return {
    canSignOutOfWorkeasy360: methods.workeasy360SignOut,
    error,
    signOut: async () => {
      if (await endSession()) router.replace('/login');
    },
    signOutOfWorkeasy360: async () => {
      if (await endSession()) window.location.assign(workeasy360LogoutUrl());
    },
  };
}
