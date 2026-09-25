'use client';

import { useEffect } from 'react';
import './globals.css';

/**
 * Last-resort boundary for failures in the root layout itself. It replaces the whole
 * document, so it cannot rely on providers — plain markup and the global stylesheet.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <body>
        <main
          role="alert"
          className="flex min-h-screen flex-col items-center justify-center gap-3 bg-background px-4 text-center text-foreground"
        >
          <h1 className="text-lg font-semibold tracking-tight">Something went wrong</h1>
          <p className="max-w-md text-sm text-muted-foreground">
            The application failed to load. Please try again in a moment.
          </p>
          {error.digest ? <p className="text-xs text-muted-foreground">Reference: {error.digest}</p> : null}
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={reset}
              className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              Try again
            </button>
            {/* A full navigation, not next/link: the router may be what broke. */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a href="/" className="inline-flex h-9 items-center rounded-md border border-input px-4 text-sm font-medium hover:bg-muted">
              Reload
            </a>
          </div>
        </main>
      </body>
    </html>
  );
}
