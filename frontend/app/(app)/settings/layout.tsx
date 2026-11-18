'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { DESTINATIONS, MODULES } from '@/lib/modules';
import { useAuthStore } from '@/stores/auth.store';
import { PageHeader } from '@/components/ui/page';

/**
 * The Settings sections come from `lib/modules.tsx`, the same list the top-bar search
 * reads, so a section cannot appear in one place and not the other.
 */
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const can = useAuthStore((state) => state.can);
  const settings = MODULES.find((module) => module.key === 'settings');
  const tabs = DESTINATIONS.filter(
    (destination) =>
      destination.moduleKey === 'settings' && (!destination.permission || can(destination.permission)),
  );

  return (
    <>
      <PageHeader title="Settings" subtitle={settings?.summary} />
      <nav aria-label="Settings sections" className="c-tabs">
        {tabs.map((tab) => (
          <Link
            key={tab.path}
            href={tab.path}
            aria-current={pathname === tab.path ? 'page' : undefined}
            className="c-tab"
          >
            {tab.label}
          </Link>
        ))}
      </nav>
      <div className="grid gap-4">{children}</div>
    </>
  );
}
