import { Suspense } from 'react';
import type { Metadata } from 'next';
import { LoginForm } from '@/components/auth/login-form';

export const metadata: Metadata = { title: 'Sign in' };

export default function LoginPage() {
  // The form reads ?next=, and useSearchParams needs a Suspense boundary in Next 15.
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
