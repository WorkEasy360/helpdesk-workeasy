'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { DESTINATIONS, MODULES } from '@/lib/modules';
import { useAuthStore } from '@/stores/auth.store';
import { PageHeader } from '@/components/ui/page';

/** The Automation sections come from `lib/modules.tsx`. */
export default function AutomationLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const can = useAuthStore((state) => state.can);
  const automation = MODULES.find((module) => module.key === 'automation');
  const tabs = DESTINATIONS.filter(
    (destination) =>
      destination.moduleKey === 'automation' && (!destination.permission || can(destination.permission)),
  );

  return (
    <>
      <PageHeader title="Automation" subtitle={automation?.summary} />
      <nav aria-label="Automation sections" className="c-tabs">
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
