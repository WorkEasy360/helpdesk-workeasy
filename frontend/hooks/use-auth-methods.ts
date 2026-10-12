'use client';

import { useQuery } from '@tanstack/react-query';
import type { AuthMethods } from '@digisoft/shared';
import { authService } from '@/services/auth.service';

/** What a deployment without the flag (an older API) or an unreachable one offers: the password form. */
export const DEFAULT_AUTH_METHODS: AuthMethods = {
  password: true,
  workeasy360: false,
  workeasy360SignOut: false,
};

/**
 * Which ways in this deployment offers: the password form, "Continue with Workeasy360", and
 * "Sign out of Workeasy360 too". Fails open to the password form, like the registration flag;
 * the API itself refuses whatever is switched off.
 */
export function useAuthMethods(): { methods: AuthMethods; isLoading: boolean } {
  const query = useQuery({
    queryKey: ['auth', 'methods'],
    queryFn: authService.methods,
    staleTime: 5 * 60_000,
    retry: false,
  });
  return { methods: query.data ?? DEFAULT_AUTH_METHODS, isLoading: query.isPending };
}
