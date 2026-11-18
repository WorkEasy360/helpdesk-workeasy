'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { LogOut } from 'lucide-react';
import { portalService } from '@/services/portal.service';
import { onColorToken } from '@/lib/design/tokens';
import { FULL_PRODUCT_NAME } from '@/components/brand/logo';
import { Button } from '@/components/ui/button';
import { ErrorState, LoadingState } from '@/components/ui/states';
import { ApiError } from '@/lib/api-client';
import { usePortalSession } from './portal-session';
import { ChatWidget } from './chat-widget';

/**
 * Header, navigation and footer for a help center.
 *
 * **The help center wears the organization's brand, not the product's.** Only the four
 * brand tokens are remapped to the organization's stored colour — accent, primary, link
 * and focus. Every neutral token and every `c-*` primitive stays exactly as the design
 * system defines it, so a merchant's colour choice can never cost them a readable page.
 * `--we-on-accent` is recomputed from the chosen colour's luminance, so text on their
 * accent clears 4.5:1 whatever they pick. See docs/DESIGN-SYSTEM.md.
 */
function brandTokens(primaryColor: string): React.CSSProperties {
  // One computation for both: whatever sits on the customer's colour, accent or navy,
  // needs the same readable foreground.
  const onColor = onColorToken(primaryColor);
  return {
    '--we-accent': primaryColor,
    '--we-accent-hover': primaryColor,
    '--we-on-accent': onColor,
    '--we-primary': primaryColor,
    '--we-primary-hover': primaryColor,
    '--we-on-primary': onColor,
    '--we-link': primaryColor,
    '--we-focus': primaryColor,
  } as React.CSSProperties;
}

export function PortalShell({ slug, children }: { slug: string; children: React.ReactNode }) {
  const pathname = usePathname();
  const session = usePortalSession();
  const config = useQuery({ queryKey: ['portal-config', slug], queryFn: () => portalService(slug).config() });

  if (config.isPending) {
    return <LoadingState label="Loading help center…" />;
  }
  if (config.isError) {
    const error = config.error;
    const missing = error instanceof ApiError && error.status === 404;
    return (
      <div className="mx-auto max-w-lg p-10">
        <ErrorState
          message={
            missing
              ? 'This help center does not exist or is not published.'
              : error instanceof ApiError
                ? error.message
                : 'Unable to load this help center.'
          }
          onRetry={missing ? undefined : () => config.refetch()}
        />
      </div>
    );
  }

  const site = config.data;
  const base = `/help/${slug}`;
  const links = [
    { href: base, label: 'Home', show: true },
    { href: `${base}/kb`, label: 'Knowledge base', show: site.kbEnabled },
    { href: `${base}/community`, label: 'Community', show: site.communityEnabled },
    { href: `${base}/tickets`, label: 'My requests', show: session.status === 'signed-in' },
  ].filter((link) => link.show);

  return (
    <div className="flex min-h-screen flex-col bg-background" style={brandTokens(site.primaryColor)}>
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3 px-4 py-3">
          <Link href={base} className="flex items-center gap-2">
            {site.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={site.logoUrl} alt="" className="h-7 w-auto" />
            ) : (
              <span className="inline-block h-6 w-6 rounded-sm bg-accent" aria-hidden />
            )}
            <span className="text-md font-semibold tracking-tight text-foreground">{site.name}</span>
          </Link>

          <nav aria-label="Help center" className="c-tabs border-b-0">
            {links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                aria-current={pathname === link.href ? 'page' : undefined}
                className="c-tab"
              >
                {link.label}
              </Link>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-2">
            {site.allowTicketSubmission ? (
              <Button asChild size="sm">
                <Link href={`${base}/submit`}>Submit a request</Link>
              </Button>
            ) : null}
            {session.status === 'signed-in' ? (
              <>
                <span className="hidden text-base text-secondary sm:inline">
                  {session.profile?.firstName}
                </span>
                <Button variant="ghost" size="sm" onClick={() => void session.signOut()}>
                  <LogOut className="h-4 w-4" aria-hidden />
                  Sign out
                </Button>
              </>
            ) : session.status === 'anonymous' ? (
              <Button asChild variant="outline" size="sm">
                <Link href={`${base}/login`}>Sign in</Link>
              </Button>
            ) : null}
          </div>
        </div>
      </header>

      <main id="main" className="mx-auto grid w-full max-w-5xl flex-1 content-start gap-6 px-4 py-6">
        {children}
      </main>

      <ChatWidget slug={slug} />

      <footer className="border-t border-border bg-surface">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-2 px-4 py-4 text-xs text-secondary">
          {/* The only product mark on a customer-facing page, and the organization can
              replace it with their own footerText. */}
          <span>{site.footerText ?? `${site.name} · powered by ${FULL_PRODUCT_NAME}`}</span>
          {site.supportEmail ? <a href={`mailto:${site.supportEmail}`}>{site.supportEmail}</a> : null}
        </div>
      </footer>
    </div>
  );
}
