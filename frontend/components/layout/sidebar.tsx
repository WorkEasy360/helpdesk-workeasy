'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { MODULES, MODULE_GROUPS, type AppModule } from '@/lib/modules';
import { useAuthStore } from '@/stores/auth.store';
import { useUiStore } from '@/stores/ui.store';
import { BrandLockup } from '@/components/brand/logo';
import { Button } from '@/components/ui/button';

/**
 * The design system's navy sidebar: 248px, the product lockup, then the modules in
 * groups, with Settings pinned to the bottom. Below 960px it becomes a drawer.
 *
 * Every row comes from `lib/modules.tsx`, so a module's label, icon and path cannot
 * drift between the sidebar, the search and the module's own page.
 */
export function Sidebar() {
  const pathname = usePathname();
  const can = useAuthStore((state) => state.can);
  const sidebarOpen = useUiStore((state) => state.sidebarOpen);
  const setSidebarOpen = useUiStore((state) => state.setSidebarOpen);

  const visible = MODULES.filter((module) => !module.permission || can(module.permission));
  const pinned = visible.filter((module) => module.pinned);
  const grouped = MODULE_GROUPS.map((group) => ({
    ...group,
    modules: visible.filter((module) => module.group === group.id && !module.pinned),
  })).filter((group) => group.modules.length > 0);

  const asideRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  // Mobile drawer behaviour: Escape closes, focus moves in on open, stays inside while
  // open, and returns to the menu button on close. Above 960px the trigger is hidden,
  // so none of this runs there.
  useEffect(() => {
    if (!sidebarOpen) {
      if (wasOpen.current) {
        wasOpen.current = false;
        const active = document.activeElement;
        if (!active || active === document.body || asideRef.current?.contains(active)) {
          document.getElementById('sidebar-trigger')?.focus();
        }
      }
      return;
    }
    const desktop = window.matchMedia('(min-width: 960px)').matches;
    if (desktop) return;
    wasOpen.current = true;
    closeRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setSidebarOpen(false);
        return;
      }
      if (event.key !== 'Tab' || !asideRef.current) return;
      const focusable = asideRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (!asideRef.current.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [sidebarOpen, setSidebarOpen]);

  const NavRow = ({ module }: { module: AppModule }) => {
    const base = module.path.split('?')[0] ?? module.path;
    const root = `/${base.split('/')[1] ?? ''}`;
    // `/settings/roles` should light up Settings, whose path is `/settings/organization`.
    const active = pathname === base || pathname.startsWith(`${base}/`) || pathname === root || pathname.startsWith(`${root}/`);
    const Icon = module.icon;
    return (
      <Link
        href={module.path}
        aria-current={active ? 'page' : undefined}
        onClick={() => setSidebarOpen(false)}
        className="c-nav-item"
      >
        <Icon aria-hidden />
        {module.label}
      </Link>
    );
  };

  return (
    <>
      {sidebarOpen ? (
        <div
          className="c-scrim fixed inset-0 z-30 shell:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden
        />
      ) : null}

      <aside
        id="app-sidebar"
        ref={asideRef}
        aria-label="Navigation"
        className={cn(
          'c-sidebar c-on-primary c-drawer shell:visible shell:static shell:translate-x-0',
          // Below 960px a closed drawer is also `invisible`, which removes it from the
          // tab order and the accessibility tree instead of leaving it merely off-screen.
          sidebarOpen ? 'visible translate-x-0' : 'invisible -translate-x-full',
        )}
      >
        <div className="flex h-topbar shrink-0 items-center justify-between gap-2 px-4">
          <Link href="/dashboard" aria-label="Go to the dashboard" className="min-w-0 rounded-md">
            <BrandLockup tone="light" />
          </Link>
          <Button
            ref={closeRef}
            variant="ghost"
            size="icon-sm"
            className="shell:hidden"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close navigation"
          >
            <X className="h-4 w-4" aria-hidden />
          </Button>
        </div>

        <nav aria-label="Main" className="flex-1 overflow-y-auto px-2 pb-2">
          {grouped.map((group) => (
            <div key={group.id} className="c-nav">
              <p className="c-nav-group-label">{group.label}</p>
              {group.modules.map((module) => (
                <NavRow key={module.key} module={module} />
              ))}
            </div>
          ))}
        </nav>

        {pinned.length > 0 ? (
          <div className="c-nav border-t border-primary-active px-2 py-2">
            {pinned.map((module) => (
              <NavRow key={module.key} module={module} />
            ))}
          </div>
        ) : null}

        {process.env.NEXT_PUBLIC_APP_VERSION ? (
          <p className="px-4 pb-3 text-xs text-primary-nav-muted">
            Version {process.env.NEXT_PUBLIC_APP_VERSION}
          </p>
        ) : null}
      </aside>
    </>
  );
}
