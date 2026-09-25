'use client';

import { RouteError } from '@/components/errors/route-error';

export default function RootError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteError error={error} reset={reset} fullScreen homeHref="/" homeLabel="Go home" />;
}
