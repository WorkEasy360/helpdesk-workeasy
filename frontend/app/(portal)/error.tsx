'use client';

import { useParams } from 'next/navigation';
import { RouteError } from '@/components/errors/route-error';

export default function PortalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const params = useParams<{ slug?: string }>();
  const home = params.slug ? `/help/${params.slug}` : '/';
  return <RouteError error={error} reset={reset} fullScreen homeHref={home} homeLabel="Back to help center" />;
}
