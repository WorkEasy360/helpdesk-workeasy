'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Building2, ChevronRight } from 'lucide-react';
import { organizationService } from '@/services/settings.service';
import { useAuthStore } from '@/stores/auth.store';
import { PERMISSIONS } from '@digisoft/shared';

/**
 * The workspace the top bar is showing. In Helpdesk the workspace is an organization,
 * and a session belongs to exactly one — the same address in another organization is a
 * separate account — so this is a label rather than a menu. It links to Settings →
 * Organization for anyone who can open it.
 */
export function WorkspaceSwitcher() {
  const can = useAuthStore((state) => state.can);
  const mayRead = can(PERMISSIONS.ORGANIZATION_READ);

  const organization = useQuery({
    queryKey: ['organization', 'current'],
    queryFn: organizationService.current,
    enabled: mayRead,
    staleTime: 5 * 60_000,
  });

  const name = organization.data?.name;

  const body = (
    <>
      <Building2 className="h-4 w-4 shrink-0 text-secondary" aria-hidden />
      {organization.isPending && mayRead ? (
        <span className="c-skeleton h-4 w-24" aria-hidden />
      ) : (
        <span className="truncate font-medium text-foreground">{name ?? 'Your workspace'}</span>
      )}
      {mayRead ? <ChevronRight className="h-4 w-4 shrink-0 text-secondary" aria-hidden /> : null}
    </>
  );

  if (!mayRead) {
    return (
      <p className="hidden min-w-0 items-center gap-2 text-base shell:flex">{body}</p>
    );
  }

  return (
    <Link
      href="/settings/organization"
      className="hidden min-w-0 items-center gap-2 rounded-md px-2 py-1 text-base transition-colors hover:bg-surface-muted shell:flex"
      title={name ? `${name} — organization settings` : 'Organization settings'}
    >
      {body}
    </Link>
  );
}
