'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  BarChart3,
  BookOpen,
  Building2,
  ClipboardList,
  MessageCircle,
  MessagesSquare,
  LayoutDashboard,
  Settings,
  Ticket,
  Users,
  Workflow,
  X,
} from 'lucide-react';
import { PERMISSIONS } from '@digisoft/shared';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth.store';
import { useUiStore } from '@/stores/ui.store';
import { Button } from '@/components/ui/button';

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  permission?: string;
}

/**
 * Only shipped areas appear here. Modules from later phases are deliberately absent
 * rather than shown as links that lead nowhere.
 */
const NAV: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/tickets', label: 'Tickets', icon: Ticket, permission: PERMISSIONS.TICKET_READ },
  { href: '/activities', label: 'Activities', icon: ClipboardList, permission: PERMISSIONS.ACTIVITY_READ },
  { href: '/customers', label: 'Customers', icon: Users, permission: PERMISSIONS.CONTACT_READ },
  { href: '/accounts', label: 'Accounts', icon: Building2, permission: PERMISSIONS.ACCOUNT_READ },
  { href: '/knowledge-base', label: 'Knowledge base', icon: BookOpen, permission: PERMISSIONS.KB_READ },
  { href: '/community', label: 'Community', icon: MessagesSquare, permission: PERMISSIONS.COMMUNITY_MODERATE },
  { href: '/chat', label: 'Live chat', icon: MessageCircle, permission: PERMISSIONS.CHAT_HANDLE },
  { href: '/automation/rules', label: 'Automation', icon: Workflow, permission: PERMISSIONS.OPERATIONS_READ },
  { href: '/reports', label: 'Reports', icon: BarChart3, permission: PERMISSIONS.REPORT_READ },
  { href: '/settings/organization', label: 'Settings', icon: Settings, permission: PERMISSIONS.ORGANIZATION_READ },
];

export function Sidebar() {
  const pathname = usePathname();
  const can = useAuthStore((state) => state.can);
  const sidebarOpen = useUiStore((state) => state.sidebarOpen);
  const setSidebarOpen = useUiStore((state) => state.setSidebarOpen);

  const items = NAV.filter((item) => !item.permission || can(item.permission));
  const asideRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  // Mobile drawer behaviour: Escape closes, focus moves in on open, stays inside while
  // open, and returns to the menu button on close. Desktop never sets `sidebarOpen`
  // from the trigger (it is hidden at lg), so none of this runs there.
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
    const desktop = window.matchMedia('(min-width: 1024px)').matches;
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

  return (
    <>
      {sidebarOpen ? (
        <div
          className="fixed inset-0 z-30 bg-black/40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden
        />
      ) : null}

      <aside
        id="app-sidebar"
        ref={asideRef}
        aria-label="Navigation"
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex w-60 flex-col border-r border-border bg-card transition-[transform,visibility] lg:visible lg:static lg:translate-x-0',
          // Below lg a closed drawer is also `invisible`, which removes it from the tab
          // order and the accessibility tree instead of leaving it merely off-screen.
          sidebarOpen ? 'visible translate-x-0' : 'invisible -translate-x-full',
        )}
      >
        <div className="flex h-14 items-center justify-between border-b border-border px-4">
          <Link href="/dashboard" className="text-sm font-semibold tracking-tight">
            Digisoft360 Help Desk
          </Link>
          <Button
            ref={closeRef}
            variant="ghost"
            size="icon"
            className="lg:hidden"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close navigation"
          >
            <X className="h-4 w-4" aria-hidden />
          </Button>
        </div>

        <nav aria-label="Main" className="flex-1 space-y-0.5 overflow-y-auto p-2">
          {items.map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                onClick={() => setSidebarOpen(false)}
                className={cn(
                  'flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
                  active
                    ? 'bg-muted font-medium text-foreground'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                <Icon className="h-4 w-4" aria-hidden />
                {item.label}
              </Link>
            );
          })}
        </nav>

        {process.env.NEXT_PUBLIC_APP_VERSION ? (
          <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">
            Version {process.env.NEXT_PUBLIC_APP_VERSION}
          </p>
        ) : null}
      </aside>
    </>
  );
}
