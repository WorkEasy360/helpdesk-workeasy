import { AlertCircle, Loader2 } from 'lucide-react';
import { Button } from './button';

/**
 * `EmptyState` lives in ./page.tsx with the rest of the page contract; it is
 * re-exported here because most pages already import it from this module.
 */
export { EmptyState } from './page';

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 p-8 text-base text-secondary" role="status">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      {label}
    </div>
  );
}

export function TableSkeleton({ rows = 5, columns = 4 }: { rows?: number; columns?: number }) {
  return (
    <div aria-hidden>
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <div key={rowIndex} className="flex gap-4 border-t border-border px-3 py-3 first:border-t-0">
          {Array.from({ length: columns }).map((__, columnIndex) => (
            <div
              key={columnIndex}
              className="c-skeleton h-4 flex-1"
              style={{ maxWidth: columnIndex === 0 ? '18rem' : undefined }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="c-empty" role="alert">
      <AlertCircle className="text-error" aria-hidden />
      <p className="c-empty-title">Something went wrong</p>
      <p className="c-empty-body">{message}</p>
      {onRetry ? (
        <Button variant="outline" size="sm" className="mt-2" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}
