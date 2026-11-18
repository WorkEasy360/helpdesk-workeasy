import { cn } from '@/lib/utils';

/**
 * A badge always carries a label, and a dot where the tone is the point — status never
 * depends on colour alone. Tones are the design system's status steps; see
 * docs/DESIGN-SYSTEM.md.
 */
export type BadgeTone = 'default' | 'success' | 'info' | 'warning' | 'danger' | 'ai' | 'brand' | 'outline';

export function Badge({
  className,
  variant = 'default',
  tone,
  dot = false,
  children,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & {
  /** Kept as the earlier prop name. `tone` is preferred in new code. */
  variant?: BadgeTone;
  tone?: BadgeTone;
  /** Show the leading dot. On by default for the status tones. */
  dot?: boolean;
}) {
  const resolved = tone ?? variant;
  const isStatus = resolved === 'success' || resolved === 'info' || resolved === 'warning' || resolved === 'danger';
  return (
    <span
      className={cn('c-badge', className)}
      data-tone={resolved === 'default' ? undefined : resolved}
      {...props}
    >
      {dot || isStatus ? <span className="c-dot" aria-hidden /> : null}
      {children}
    </span>
  );
}
