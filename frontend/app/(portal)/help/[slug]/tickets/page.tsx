'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { ApiError } from '@/lib/api-client';
import { portalService } from '@/services/portal.service';
import { formatDateTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { Pagination } from '@/components/ui/pagination';
import { usePortalSession } from '@/components/portal/portal-session';

export default function MyRequestsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const api = portalService(slug);
  const router = useRouter();
  const session = usePortalSession();
  const [page, setPage] = useState(1);
  const [openOnly, setOpenOnly] = useState(false);

  const tickets = useQuery({
    queryKey: ['portal-tickets', slug, { page, openOnly }],
    queryFn: () => api.tickets({ page, pageSize: 10, ...(openOnly ? { open: true } : {}) }),
    enabled: session.status === 'signed-in',
  });

  // Navigating is a side effect, so it happens after render rather than during it.
  useEffect(() => {
    if (session.status === 'anonymous') {
      router.replace(`/help/${slug}/login?next=tickets`);
    }
  }, [session.status, router, slug]);

  if (session.status === 'loading') {
    return <LoadingState />;
  }
  if (session.status === 'anonymous') {
    return <LoadingState label="Taking you to sign in…" />;
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold tracking-tight">My requests</h1>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2 text-base">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={openOnly}
              onChange={(event) => {
                setPage(1);
                setOpenOnly(event.target.checked);
              }}
            />
            Open only
          </label>
          <Button asChild size="sm">
            <Link href={`/help/${slug}/submit`}>
              <Plus className="h-4 w-4" aria-hidden />
              New request
            </Link>
          </Button>
        </div>
      </div>

      {tickets.isPending ? (
        <LoadingState />
      ) : tickets.isError ? (
        <ErrorState
          message={
            tickets.error instanceof ApiError ? tickets.error.message : 'Unable to load your requests.'
          }
          onRetry={() => tickets.refetch()}
        />
      ) : tickets.data && tickets.data.items.length > 0 ? (
        <>
          <div className="space-y-3">
            {tickets.data.items.map((ticket) => (
              <Card key={ticket.id}>
                <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
                  <div className="min-w-0">
                    <Link className="font-medium hover:underline" href={`/help/${slug}/tickets/${ticket.id}`}>
                      #{ticket.ticketNumber} · {ticket.subject}
                    </Link>
                    <p className="text-xs text-muted-foreground">
                      Raised {formatDateTime(ticket.createdAt)}
                      {ticket.assignedAgent ? ` · with ${ticket.assignedAgent.firstName}` : ''}
                    </p>
                  </div>
                  <Badge
                    variant={ticket.status.isClosed ? 'default' : ticket.status.isResolved ? 'success' : 'outline'}
                  >
                    {ticket.status.name}
                  </Badge>
                </CardContent>
              </Card>
            ))}
          </div>
          <Pagination meta={tickets.data.meta} onPageChange={setPage} />
        </>
      ) : (
        <EmptyState
          title="No requests yet"
          description="When you raise a request it appears here with every reply from the team."
          action={
            <Button asChild>
              <Link href={`/help/${slug}/submit`}>Submit a request</Link>
            </Button>
          }
        />
      )}
    </>
  );
}
