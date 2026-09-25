'use client';

import { useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { ApiError, onSessionExpired } from '@/lib/api-client';
import { useAuthStore } from '@/stores/auth.store';
import { ConfirmProvider } from '@/components/ui/confirm-dialog';
import { ThemeProvider, useTheme } from '@/components/theme-provider';

export function Providers({ children }: { children: React.ReactNode }) {
  const clear = useAuthStore((state) => state.clear);

  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            retry: (failureCount, error) => {
              // Never retry a rejection the user has to act on — and never retry a 429,
              // which would spend the remaining budget making the throttling worse.
              if (
                error instanceof ApiError &&
                [400, 401, 403, 404, 409, 413, 415, 429].includes(error.status)
              ) {
                return false;
              }
              return failureCount < 2;
            },
            refetchOnWindowFocus: false,
          },
        },
      }),
  );

  useEffect(() => {
    onSessionExpired(() => {
      clear();
      queryClient.clear();
    });
  }, [clear, queryClient]);

  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <ConfirmProvider>{children}</ConfirmProvider>
        <ThemedToaster />
      </QueryClientProvider>
    </ThemeProvider>
  );
}

function ThemedToaster() {
  const { resolvedTheme } = useTheme();
  return <Toaster position="top-right" richColors closeButton theme={resolvedTheme} />;
}
