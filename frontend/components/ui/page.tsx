import * as React from 'react';
import Link from 'next/link';
import { Inbox, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * The page contract. Every screen is built from these, in this order:
 *
 *   <Page>
 *     <PageHeader eyebrow title subtitle actions />
 *     optional .c-toolbar or .c-tabs
 *     <Card> / .c-stats with <StatCard> / .c-table-wrap / .c-form
 *     <EmptyState> before there is data
 *   </Page>
 *
 * See docs/DESIGN-SYSTEM.md.
 */

/** Centred 1200px container. `narrow` caps content at 880px, same left edge. */
export function Page({
  narrow = false,
  className,
  children,
  ...props
}: { narrow?: boolean } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('c-page', className)} data-narrow={narrow || undefined} {...props}>
      {children}
    </div>
  );
}

export function PageHeader({
  eyebrow,
  title,
  subtitle,
  /** Accepted as an alias for `subtitle`, which earlier pages called `description`. */
  description,
  actions,
  className,
}: {
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  const sub = subtitle ?? description;
  return (
    <div className={cn('c-page-header', className)}>
      <div className="min-w-0">
        {eyebrow ? <p className="c-eyebrow">{eyebrow}</p> : null}
        <h1 className="c-page-title">{title}</h1>
        {sub ? <p className="c-page-subtitle">{sub}</p> : null}
      </div>
      {/* The primary action sits at the right edge. */}
      {actions ? <div className="c-toolbar">{actions}</div> : null}
    </div>
  );
}

/**
 * One number and its label. A `href` makes the whole tile a link into the list the
 * number counts. `tone` only ever reinforces a value that is already spelled out in
 * `sub`, so the colour is never the only signal.
 */
export function StatCard({
  label,
  value,
  sub,
  tone = 'default',
  loading = false,
  href,
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: 'default' | 'success' | 'warning' | 'danger';
  loading?: boolean;
  href?: string;
  className?: string;
}) {
  const body = (
    <>
      <p className="c-stat-label">{label}</p>
      {loading ? (
        <div className="c-skeleton mt-1 h-6 w-16" aria-hidden />
      ) : (
        <p className="c-stat-value" data-tone={tone === 'default' ? undefined : tone}>
          {value}
        </p>
      )}
      {sub ? <p className="c-stat-sub">{sub}</p> : null}
    </>
  );

  if (href) {
    return (
      <Link href={href} className={cn('c-stat', className)}>
        {body}
      </Link>
    );
  }
  return <div className={cn('c-stat', className)}>{body}</div>;
}

/** The grid stat cards sit in. */
export function StatGrid({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('c-stats', className)} {...props} />;
}

export function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  actions,
  action,
  className,
}: {
  icon?: LucideIcon;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Earlier pages passed a single `action`; both are accepted. */
  actions?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  const footer = actions ?? action;
  return (
    <div className={cn('c-empty', className)}>
      <Icon aria-hidden />
      <p className="c-empty-title">{title}</p>
      {description ? <p className="c-empty-body">{description}</p> : null}
      {footer ? <div className="c-toolbar mt-2 justify-center">{footer}</div> : null}
    </div>
  );
}
