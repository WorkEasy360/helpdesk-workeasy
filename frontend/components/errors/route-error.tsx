'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { AlertCircle, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Body of every `error.tsx` boundary: says what happened without leaking internals,
 * offers a retry, and a way out. The digest lets support match the server log line.
 */
export function RouteError({
  error,
  reset,
  homeHref = '/dashboard',
  homeLabel = 'Go to dashboard',
  fullScreen = false,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  homeHref?: string;
  homeLabel?: string;
  fullScreen?: boolean;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div
      role="alert"
      className={
        fullScreen
          ? 'flex min-h-screen flex-col items-center justify-center gap-3 bg-background px-4 text-center text-foreground'
          : 'flex flex-col items-center justify-center gap-3 px-4 py-16 text-center'
      }
    >
      <AlertCircle className="h-10 w-10 text-destructive" aria-hidden />
      <h1 className="text-lg font-semibold tracking-tight">Something went wrong</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        An unexpected error stopped this page from loading. Try again, and if it keeps happening
        contact your administrator.
      </p>
      {error.digest ? (
        <p className="text-xs text-muted-foreground">
          Reference: <code className="rounded bg-muted px-1 py-0.5">{error.digest}</code>
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap justify-center gap-2">
        <Button onClick={reset}>
          <RotateCcw className="h-4 w-4" aria-hidden />
          Try again
        </Button>
        <Button variant="outline" asChild>
          <Link href={homeHref}>{homeLabel}</Link>
        </Button>
      </div>
    </div>
  );
}
