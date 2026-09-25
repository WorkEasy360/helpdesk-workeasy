'use client';

import { PortalSessionProvider } from '@/components/portal/portal-session';
import { PortalShell } from '@/components/portal/portal-shell';

export function HelpCenterLayout({ slug, children }: { slug: string; children: React.ReactNode }) {
  return (
    <PortalSessionProvider slug={slug}>
      <PortalShell slug={slug}>{children}</PortalShell>
    </PortalSessionProvider>
  );
}
