'use client';

import { usePathname } from 'next/navigation';
import { useRequireAuth } from '@/hooks/use-session';
import { useRealtime } from '@/hooks/use-realtime';
import { AssistantPanel } from '@/components/assistant/assistant-panel';
import { Sidebar } from '@/components/layout/sidebar';
import { Topbar } from '@/components/layout/topbar';
import { LoadingState } from '@/components/ui/states';

/**
 * The application shell: navy sidebar, white top bar, then the page.
 *
 * `<main>` *is* the page contract's `<Page>` container — a centred 1200px column with
 * the 16px grid gap between sections — so a module page starts straight in at its
 * `<PageHeader>`. See docs/DESIGN-SYSTEM.md.
 */

/**
 * The agent workspace fills the viewport and manages its own scrolling, so it opts out
 * of the page container rather than fighting it with negative margins.
 */
function isFullBleed(pathname: string): boolean {
  return /^\/tickets\/[^/]+$/.test(pathname);
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const status = useRequireAuth();
  const pathname = usePathname();
  useRealtime();

  if (status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <LoadingState label="Restoring your session…" />
      </div>
    );
  }

  return (
    <div className="c-shell">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        <main
          id="main"
          className={isFullBleed(pathname) ? 'flex min-w-0 flex-1 flex-col' : 'c-page'}
        >
          {children}
        </main>
      </div>
      {/* The assistant floats above every agent page. It renders nothing for a role
          without `ai.use`. */}
      <AssistantPanel />
    </div>
  );
}
