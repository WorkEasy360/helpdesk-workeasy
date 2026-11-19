'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { signInPageFor, startUrlFor } from '@/lib/auto-sign-in';
import { Button } from '@/components/ui/button';

/** After this long without Workeasy360 taking over, the person is offered a way out. */
export const SIGNING_IN_SLOW_AFTER_MS = 5_000;

/**
 * Shown for the moment between opening an agent page with no session and Workeasy360 taking
 * over (SSO-only deployments, `lib/auto-sign-in.ts`). It is not the sign-in page: there is
 * nothing to choose or type, until it takes longer than expected. Then the same start link as
 * the sign-in page's button, and a link to the sign-in page, appear. One h1; the text uses the
 * foreground colour, not a muted one; the live region is the `role="status"` text (not `main`,
 * which would hide it behind `aria-busy`); the spinner stands still for people who ask for that.
 */
export function SigningInWithWorkeasy360() {
  const [slow, setSlow] = useState(false);
  const [links, setLinks] = useState<{ start: string; signIn: string } | null>(null);

  useEffect(() => {
    const page = `${window.location.pathname}${window.location.search}`;
    setLinks({ start: startUrlFor(page), signIn: signInPageFor(page) });
    const timer = setTimeout(() => setSlow(true), SIGNING_IN_SLOW_AFTER_MS);
    return () => clearTimeout(timer);
  }, []);

  return (
    <main
      id="main"
      className="flex min-h-screen flex-col items-center justify-center gap-3 bg-background px-4 text-center text-foreground"
    >
      <Loader2 className="h-5 w-5 motion-safe:animate-spin" aria-hidden />
      <h1 className="text-lg font-semibold tracking-tight">Signing you in with Workeasy360…</h1>
      <div role="status" className="space-y-1 text-sm">
        <p>You will come straight back to this page.</p>
        {slow ? <p>This is taking longer than expected.</p> : null}
      </div>
      {slow && links ? (
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <Button asChild>
            <a href={links.start}>Continue with Workeasy360</a>
          </Button>
          <Button asChild variant="outline">
            <a href={links.signIn}>Go to the sign-in page</a>
          </Button>
        </div>
      ) : null}
    </main>
  );
}
