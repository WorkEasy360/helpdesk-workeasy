'use client';

import { useQuery } from '@tanstack/react-query';
import { authService } from '@/services/auth.service';

/**
 * Whether this deployment lets new organizations sign up. Fails open — an API that
 * predates the flag, or a failed check, still offers sign-up; the register route itself
 * refuses when it is switched off.
 */
export function useRegistrationEnabled(): boolean {
  const status = useQuery({
    queryKey: ['auth', 'registration'],
    queryFn: authService.registrationStatus,
    staleTime: 5 * 60_000,
    retry: false,
  });
  return status.data?.enabled ?? true;
}
