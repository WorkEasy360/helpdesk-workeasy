'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, Check, LogOut, Menu, Monitor, Moon, Sun, UserRound } from 'lucide-react';
import { authService } from '@/services/auth.service';
import { notificationsService } from '@/services/notifications.service';
import { useAuthStore } from '@/stores/auth.store';
import { useUiStore } from '@/stores/ui.store';
import { initials, formatDateTime, cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { useTheme, type Theme } from '@/components/theme-provider';

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
            <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-medium text-destructive-foreground">
              {unread.count > 9 ? '9+' : unread.count}
            </span>
          ) : null}
        </span>
      </Button>

      {open ? (
        <div className="absolute right-0 top-full z-50 mt-2 w-80 rounded-md border border-border bg-background shadow-lg">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <p className="text-sm font-medium">Notifications</p>
            {unread?.count ? (
              <button
                type="button"
                className="rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => markAllRead.mutate()}
              >
                Mark all read
              </button>
            ) : null}
          </div>

          <div className="max-h-96 overflow-y-auto">
            {notifications.isPending ? (
              <div className="p-4">
                <LoadingState />
              </div>
            ) : notifications.isError ? (
              <div className="p-4">
                <ErrorState message="Unable to load notifications." onRetry={() => notifications.refetch()} />
              </div>
            ) : notifications.data.items.length === 0 ? (
              <div className="p-4">
                <EmptyState title="No notifications" description="You're all caught up." />
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {notifications.data.items.map((notification) => (
                  <li key={notification.id}>
                    <button
                      type="button"
                      className={cn(
                        'block w-full px-3 py-2 text-left text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                        !notification.readAt && 'bg-muted/50',
                      )}
                      onClick={() => {
                        if (!notification.readAt) markRead.mutate(notification.id);
                        setOpen(false);
                        if (notification.link) router.push(notification.link);
                      }}
                    >
                      <span className="flex items-start justify-between gap-2">
                        <span className="font-medium">{notification.title}</span>
                        {!notification.readAt ? (
                          <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-primary" aria-hidden />
                        ) : null}
                      </span>
                      {notification.body ? (
                        <span className="mt-0.5 block text-xs text-muted-foreground">{notification.body}</span>
                      ) : null}
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {formatDateTime(notification.createdAt)}
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

const THEMES: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
];

const menuItemClass =
  'flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-muted data-[disabled]:pointer-events-none data-[disabled]:opacity-50';

export function Topbar() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { theme, setTheme } = useTheme();
  const user = useAuthStore((state) => state.user);
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
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-background px-3">
      <Button
        id="sidebar-trigger"
        variant="ghost"
        size="icon"
        className="lg:hidden"
        onClick={toggleSidebar}
        aria-label="Open navigation"
        aria-controls="app-sidebar"
        aria-expanded={sidebarOpen}
      >
        <Menu className="h-4 w-4" aria-hidden />
      </Button>

      <div className="ml-auto flex items-center gap-2">
        <NotificationsMenu />

        {user ? (
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                className="flex items-center gap-2 rounded-md border-l border-border py-1 pl-2 pr-1 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`Account menu for ${user.firstName} ${user.lastName}`}
              >
                <span
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-xs font-medium"
                  aria-hidden
                >
                  {initials(user.firstName, user.lastName)}
                </span>
                <span className="hidden text-sm leading-tight sm:block">
                  <span className="block font-medium">
                    {user.firstName} {user.lastName}
                  </span>
                  <span className="block text-xs text-muted-foreground">{user.roles.join(', ')}</span>
                </span>
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                align="end"
                sideOffset={6}
                className="z-50 min-w-52 rounded-md border border-border bg-background p-1 text-foreground shadow-lg"
              >
                <DropdownMenu.Label className="px-2 py-1.5">
                  <p className="truncate text-sm font-medium">
                    {user.firstName} {user.lastName}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">{user.email}</p>
                </DropdownMenu.Label>
                <DropdownMenu.Separator className="my-1 h-px bg-border" />
                <DropdownMenu.Item asChild className={menuItemClass}>
                  <Link href="/settings/profile">
                    <UserRound className="h-4 w-4" aria-hidden />
                    Your profile
                  </Link>
                </DropdownMenu.Item>
                <DropdownMenu.Separator className="my-1 h-px bg-border" />
                <DropdownMenu.Label className="px-2 py-1 text-xs text-muted-foreground">Theme</DropdownMenu.Label>
                <DropdownMenu.RadioGroup value={theme} onValueChange={(value) => setTheme(value as Theme)}>
                  {THEMES.map((option) => {
                    const Icon = option.icon;
                    return (
                      <DropdownMenu.RadioItem key={option.value} value={option.value} className={menuItemClass}>
                        <Icon className="h-4 w-4" aria-hidden />
                        {option.label}
                        <DropdownMenu.ItemIndicator className="ml-auto">
                          <Check className="h-4 w-4" aria-hidden />
                        </DropdownMenu.ItemIndicator>
                      </DropdownMenu.RadioItem>
                    );
                  })}
                </DropdownMenu.RadioGroup>
                <DropdownMenu.Separator className="my-1 h-px bg-border" />
                <DropdownMenu.Item className={menuItemClass} onSelect={() => void signOut()}>
                  <LogOut className="h-4 w-4" aria-hidden />
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
