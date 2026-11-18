'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Pencil } from 'lucide-react';
import { PERMISSIONS } from '@digisoft/shared';
import { ApiError } from '@/lib/api-client';
import { accountsService } from '@/services/accounts.service';
import { useAuthStore } from '@/stores/auth.store';
import { formatDateTime } from '@/lib/utils';
import { PageHeader } from '@/components/layout/page-header';
import { AccountFormDialog } from '@/components/accounts/account-form-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DataTable, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-3 gap-2 border-b border-border py-2 last:border-0">
      <dt className="text-base text-muted-foreground">{label}</dt>
      <dd className="col-span-2 text-base">{children}</dd>
    </div>
  );
}

export default function AccountDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const can = useAuthStore((state) => state.can);
  const [editOpen, setEditOpen] = useState(false);

  const account = useQuery({
    queryKey: ['accounts', params.id],
    queryFn: () => accountsService.get(params.id),
  });
  const contacts = useQuery({
    queryKey: ['accounts', params.id, 'contacts'],
    queryFn: () => accountsService.contacts(params.id),
    enabled: account.isSuccess,
  });

  if (account.isPending) {
    return <LoadingState label="Loading account…" />;
  }
  if (account.isError) {
    const notFound = account.error instanceof ApiError && account.error.status === 404;
    return (
      <ErrorState
        message={notFound ? 'This account does not exist in your organization.' : 'Unable to load the account.'}
        onRetry={notFound ? undefined : () => account.refetch()}
      />
    );
  }

  const data = account.data;

  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => router.push('/accounts')} className="-ml-2">
        <ArrowLeft className="h-4 w-4" aria-hidden />
        Back to accounts
      </Button>

      <PageHeader
        title={data.name}
        description={data.industry ?? undefined}
        actions={
          can(PERMISSIONS.ACCOUNT_UPDATE) ? (
            <Button variant="outline" onClick={() => setEditOpen(true)}>
              <Pencil className="h-4 w-4" aria-hidden />
              Edit
            </Button>
          ) : null
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle>Company details</CardTitle>
          </CardHeader>
          <CardContent>
            <dl>
              <DetailRow label="Website">{data.website ?? '—'}</DetailRow>
              <DetailRow label="Email">{data.email ?? '—'}</DetailRow>
              <DetailRow label="Phone">{data.phone ?? '—'}</DetailRow>
              <DetailRow label="Address">
                {[data.addressLine1, data.city, data.state, data.postalCode, data.country]
                  .filter(Boolean)
                  .join(', ') || '—'}
              </DetailRow>
              <DetailRow label="Created">{formatDateTime(data.createdAt)}</DetailRow>
            </dl>
            {data.description ? (
              <p className="mt-3 whitespace-pre-line text-base text-muted-foreground">
                {data.description}
              </p>
            ) : null}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Contacts</CardTitle>
          </CardHeader>
          {contacts.isPending ? (
            <LoadingState />
          ) : contacts.isError ? (
            <ErrorState message="Unable to load contacts." onRetry={() => contacts.refetch()} />
          ) : contacts.data.length === 0 ? (
            <EmptyState
              title="No contacts linked"
              description="Assign contacts to this account from the customer record."
            />
          ) : (
            <DataTable>
              <THead>
                <TR>
                  <TH>Name</TH>
                  <TH>Email</TH>
                  <TH>Job title</TH>
                </TR>
              </THead>
              <TBody>
                {contacts.data.map((contact) => (
                  <TR key={contact.id}>
                    <TD>
                      <Link href={`/customers/${contact.id}`} className="font-medium hover:underline">
                        {contact.firstName} {contact.lastName ?? ''}
                      </Link>
                    </TD>
                    <TD className="text-muted-foreground">{contact.email ?? '—'}</TD>
                    <TD className="text-muted-foreground">{contact.jobTitle ?? '—'}</TD>
                  </TR>
                ))}
              </TBody>
            </DataTable>
          )}
        </Card>
      </div>

      <AccountFormDialog open={editOpen} onOpenChange={setEditOpen} account={data} />
    </>
  );
}
