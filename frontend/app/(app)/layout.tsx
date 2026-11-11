'use client';

import { useRequireAuth } from '@/hooks/use-session';
import { useRealtime } from '@/hooks/use-realtime';
import { Sidebar } from '@/components/layout/sidebar';
import { Topbar } from '@/components/layout/topbar';
import { SigningInWithWorkeasy360 } from '@/components/auth/signing-in';
import { LoadingState } from '@/components/ui/states';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const status = useRequireAuth();
  useRealtime();

  // Opened with no session on an SSO-only deployment: Workeasy360 is taking over right now.
  if (status === 'signing-in') {
    return <SigningInWithWorkeasy360 />;
  }

  if (status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <LoadingState label="Restoring your session…" />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        <main id="main" className="flex-1 space-y-4 p-4 lg:p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
