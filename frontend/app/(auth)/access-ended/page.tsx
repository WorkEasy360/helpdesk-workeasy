import { Suspense } from 'react';
import type { Metadata } from 'next';
import { AccessEnded } from '@/components/auth/access-ended';
import { LoadingState } from '@/components/ui/states';

export const metadata: Metadata = { title: 'Access ended' };

export default function AccessEndedPage() {
  // The screen reads ?reason=, and useSearchParams needs a Suspense boundary in Next 15.
  return (
    <Suspense fallback={<LoadingState />}>
      <AccessEnded />
    </Suspense>
  );
}
