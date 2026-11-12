'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, ExternalLink, LogOut, Menu, Settings, UserRound } from 'lucide-react';
import { PERMISSIONS } from '@digisoft/shared';
import { authService } from '@/services/auth.service';
import { notificationsService } from '@/services/notifications.service';
import { organizationService } from '@/services/settings.service';
import { useAuthStore } from '@/stores/auth.store';
import { useUiStore } from '@/stores/ui.store';
import { initials, formatDateTime, cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { CommandSearch } from '@/components/layout/command-search';
import { ThemeToggle } from '@/components/layout/theme-toggle';
import { WorkspaceSwitcher } from '@/components/layout/workspace-switcher';

function NotificationsMenu() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const { data: unread } = useQuery({
    queryKey: ['notifications', 'unread-count'],
    queryFn: notificationsService.unreadCount,
    refetchInterval: 60_000,
  });

  const notifications = useQuery({
    queryKey: ['notifications', 'list'],
    queryFn: () => notificationsService.list({ page: 1, pageSize: 10 }),
    enabled: open,
  });

  const markRead = useMutation({
    mutationFn: (id: string) => notificationsService.markRead(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });

  const markAllRead = useMutation({
    mutationFn: () => notificationsService.markAllRead(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <Button
        variant="ghost"
        size="icon"
        aria-label={`Notifications${unread?.count ? `, ${unread.count} unread` : ''}`}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="relative">
          <Bell className="h-4 w-4" aria-hidden />
          {unread?.count ? (
            <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-error px-1 text-xs font-medium tabular-nums text-destructive-foreground">
              {unread.count > 9 ? '9+' : unread.count}
            </span>
          ) : null}
        </span>
      </Button>

      {open ? (
        <div className="c-menu absolute right-0 top-full z-50 mt-2 w-80 max-w-[calc(100vw-2rem)]">
          <div className="flex items-center justify-between gap-2 border-b border-border px-2 pb-2">
            <p className="text-base font-medium text-foreground">Notifications</p>
            {unread?.count ? (
              <button
                type="button"
                className="rounded-sm text-xs text-secondary transition-colors hover:text-foreground"
                onClick={() => markAllRead.mutate()}
              >
                Mark all read
              </button>
            ) : null}
          </div>

          <div className="max-h-96 overflow-y-auto">
            {notifications.isPending ? (
              <LoadingState />
            ) : notifications.isError ? (
              <ErrorState message="Unable to load notifications." onRetry={() => notifications.refetch()} />
            ) : notifications.data.items.length === 0 ? (
              <EmptyState title="No notifications" description="You're all caught up." />
            ) : (
              <ul>
                {notifications.data.items.map((notification) => (
                  <li key={notification.id}>
                    <button
                      type="button"
                      className={cn(
                        'c-menu-item block w-full text-left',
                        !notification.readAt && 'bg-accent-soft',
                      )}
                      onClick={() => {
                        if (!notification.readAt) markRead.mutate(notification.id);
                        setOpen(false);
                        if (notification.link) router.push(notification.link);
                      }}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="flex items-start justify-between gap-2">
                          <span className="font-medium text-foreground">{notification.title}</span>
                          {!notification.readAt ? (
                            <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-accent" aria-hidden />
                          ) : null}
                        </span>
                        {notification.body ? (
                          <span className="mt-0.5 block text-xs text-secondary">{notification.body}</span>
                        ) : null}
                        <span className="mt-0.5 block text-xs text-secondary">
                          {formatDateTime(notification.createdAt)}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** "View help center" — the product action, per docs/DESIGN-SYSTEM.md. */
function ViewHelpCenter() {
  const can = useAuthStore((state) => state.can);
  const organization = useQuery({
    queryKey: ['organization', 'current'],
    queryFn: organizationService.current,
    enabled: can(PERMISSIONS.PORTAL_READ),
    staleTime: 5 * 60_000,
  });

  const slug = organization.data?.slug;
  if (!slug) return null;

  return (
    <Button asChild variant="outline" size="sm" className="hidden shell:inline-flex">
      <a href={`/help/${slug}`} target="_blank" rel="noreferrer">
        View help center
        <ExternalLink className="h-4 w-4" aria-hidden />
      </a>
    </Button>
  );
}

export function Topbar() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const user = useAuthStore((state) => state.user);
  const can = useAuthStore((state) => state.can);
  const clear = useAuthStore((state) => state.clear);
  const toggleSidebar = useUiStore((state) => state.toggleSidebar);
  const sidebarOpen = useUiStore((state) => state.sidebarOpen);

  const signOut = async () => {
    await authService.logout().catch(() => undefined);
    clear();
    // Drop every cached response so the next person on this browser sees nothing of ours.
    queryClient.clear();
    router.replace('/login');
  };

  return (
    <header className="c-topbar">
      <Button
        id="sidebar-trigger"
        variant="ghost"
        size="icon"
        className="shell:hidden"
        onClick={toggleSidebar}
        aria-label="Open navigation"
        aria-controls="app-sidebar"
        aria-expanded={sidebarOpen}
      >
        <Menu className="h-4 w-4" aria-hidden />
      </Button>

      {/* Left: the workspace switcher and search. */}
      <WorkspaceSwitcher />
      <div className="min-w-0 flex-1">
        <CommandSearch />
      </div>

      {/* Right: product actions, notifications, settings, theme and the account menu. */}
      <div className="flex shrink-0 items-center gap-1">
        <ViewHelpCenter />
        <NotificationsMenu />
        {can(PERMISSIONS.ORGANIZATION_READ) ? (
          <Button asChild variant="ghost" size="icon" className="hidden shell:inline-flex">
            <Link href="/settings/organization" aria-label="Settings">
              <Settings className="h-4 w-4" aria-hidden />
            </Link>
          </Button>
        ) : null}
        <ThemeToggle />

        {user ? (
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                className="ml-1 flex items-center gap-2 rounded-md py-1 pl-1 pr-2 text-left transition-colors hover:bg-surface-muted"
                aria-label={`Account menu for ${user.firstName} ${user.lastName}`}
              >
                <span
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-xs font-medium text-primary-foreground"
                  aria-hidden
                >
                  {initials(user.firstName, user.lastName)}
                </span>
                <span className="hidden text-base leading-tight sm:block">
                  <span className="block font-medium text-foreground">
                    {user.firstName} {user.lastName}
                  </span>
                  <span className="block text-xs text-secondary">{user.roles.join(', ')}</span>
                </span>
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content align="end" sideOffset={6} className="c-menu z-50 min-w-52">
                <DropdownMenu.Label className="px-2 py-1.5">
                  <p className="truncate text-base font-medium text-foreground">
                    {user.firstName} {user.lastName}
                  </p>
                  <p className="truncate text-xs text-secondary">{user.email}</p>
                </DropdownMenu.Label>
                <DropdownMenu.Separator className="c-menu-separator" />
                <DropdownMenu.Item asChild className="c-menu-item">
                  <Link href="/settings/profile">
                    <UserRound aria-hidden />
                    Your profile
                  </Link>
                </DropdownMenu.Item>
                <DropdownMenu.Separator className="c-menu-separator" />
                <DropdownMenu.Item className="c-menu-item" onSelect={() => void signOut()}>
                  <LogOut aria-hidden />
                  Sign out
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        ) : null}
      </div>
    </header>
  );
}
