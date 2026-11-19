'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { authService } from '@/services/auth.service';
import { useAuthStore } from '@/stores/auth.store';
import { ApiError } from '@/lib/api-client';
import { clearSignedOutMarker, markSignedOut } from '@/lib/auto-sign-in';
import { workeasy360LogoutUrl } from '@/lib/sso';
import { useAuthMethods } from '@/hooks/use-auth-methods';

export const SIGN_OUT_FAILED = 'Could not sign you out. Check your connection and try again.';

/** Whether a failed sign-out request clearly means "the server refused and you are still signed in". */
function refusedAndStillSignedIn(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  // 401 means there is no session to end. 408 and 429 say nothing about the session either.
  return error.status >= 400 && error.status < 500 && ![401, 408, 429].includes(error.status);
}

/**
 * "Sign out" ends this app's session only. "Sign out of Easy Help Desk and Workeasy360" ends it
 * first, then navigates to the API's sign-out route, which sends the browser on to
 * Workeasy360's own sign-out confirmation (and back to the sign-in page afterwards).
 *
 * The session is ended on the server (the refresh token family is revoked). If that request
 * fails - twice - nothing is cleared and nobody is sent anywhere: the person is told, and is
 * still signed in, rather than looking signed out while the session lives on.
 *
 * Both entries leave the signed-out marker (a session cookie) behind, so opening the Help Desk
 * again shows the sign-in page instead of signing straight back in through a Workeasy360
 * session that is still alive. It is written BEFORE the request is sent, so no other tab can
 * start a sign-in in the gap. It is taken back only when the server clearly refused (a 4xx
 * other than 401, 408 and 429): on a 401 (no session left), a network error or a 5xx it stays,
 * because the session may well be gone. Only a real sign-in clears it (`lib/auto-sign-in.ts`).
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
    markSignedOut();
    let ended = false;
    for (let attempt = 0; attempt < 2 && !ended; attempt += 1) {
      try {
        await authService.logout();
        ended = true;
      } catch (failure) {
        if (failure instanceof ApiError && failure.status === 401) {
          // There is no session to end: the person is as signed out as they asked to be.
          ended = true;
        } else if (refusedAndStillSignedIn(failure)) {
          clearSignedOutMarker();
          break;
        }
        // Otherwise (network error, 5xx): one more try, then say so. The marker stays.
      }
    }
    if (!ended) {
      setError(SIGN_OUT_FAILED);
      toast.error(SIGN_OUT_FAILED);
      return false;
    }
    clear();
    // Drop every cached response so the next person on this browser sees nothing of ours.
    queryClient.clear();
    return true;
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
