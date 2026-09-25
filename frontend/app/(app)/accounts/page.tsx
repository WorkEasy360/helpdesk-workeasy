'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { PERMISSIONS } from '@digisoft/shared';
import { ApiError } from '@/lib/api-client';
import { accountsService } from '@/services/accounts.service';
import { useAuthStore } from '@/stores/auth.store';
import { formatDate } from '@/lib/utils';
import { PageHeader } from '@/components/layout/page-header';
import { AccountFormDialog } from '@/components/accounts/account-form-dialog';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
import { DataTable, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { Pagination } from '@/components/ui/pagination';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/ui/states';

export default function AccountsPage() {
  const can = useAuthStore((state) => state.can);
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);

  const params = useMemo(
    () => ({ page, pageSize: 25, q: query || undefined, sort: 'name', order: 'asc' as const }),
    [page, query],
  );

  const accounts = useQuery({
    queryKey: ['accounts', params],
    queryFn: () => accountsService.list(params),
  });

  const remove = useMutation({
    mutationFn: (id: string) => accountsService.remove(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['accounts'] });
      await queryClient.invalidateQueries({ queryKey: ['contacts'] });
      toast.success('Account deleted');
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : 'Unable to delete the account.'),
  });

  return (
    <>
      <PageHeader
        title="Accounts"
        description="Companies your contacts belong to."
        actions={
          can(PERMISSIONS.ACCOUNT_CREATE) ? (
            <Button onClick={() => setDialogOpen(true)}>
              <Plus className="h-4 w-4" aria-hidden />
              New account
            </Button>
          ) : null
        }
      />

      <form
        className="flex max-w-md items-center gap-2"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          setPage(1);
          setQuery(search.trim());
        }}
      >
        <label htmlFor="account-search" className="sr-only">
          Search accounts
        </label>
        <Input
          id="account-search"
          placeholder="Search by name, email or website"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <Button type="submit" variant="outline">
          <Search className="h-4 w-4" aria-hidden />
          Search
        </Button>
      </form>

      <Card>
        {accounts.isPending ? (
          <TableSkeleton columns={5} />
        ) : accounts.isError ? (
          <ErrorState
            message={
              accounts.error instanceof ApiError ? accounts.error.message : 'Unable to load accounts.'
            }
            onRetry={() => accounts.refetch()}
          />
        ) : accounts.data.items.length === 0 ? (
          <EmptyState
            title={query ? 'No accounts match that search' : 'No accounts yet'}
            description={
              query ? 'Try a different company name.' : 'Create the first customer company.'
            }
            action={
              can(PERMISSIONS.ACCOUNT_CREATE) && !query ? (
                <Button onClick={() => setDialogOpen(true)}>New account</Button>
              ) : null
            }
          />
        ) : (
          <>
            <DataTable>
              <THead>
                <TR>
                  <TH>Company</TH>
                  <TH>Industry</TH>
                  <TH>Location</TH>
                  <TH className="text-right">Contacts</TH>
                  <TH>Added</TH>
                  <TH><span className="sr-only">Actions</span></TH>
                </TR>
              </THead>
              <TBody>
                {accounts.data.items.map((account) => (
                  <TR key={account.id}>
                    <TD>
                      <Link href={`/accounts/${account.id}`} className="font-medium hover:underline">
                        {account.name}
                      </Link>
                      {account.website ? (
                        <p className="text-xs text-muted-foreground">{account.website}</p>
                      ) : null}
                    </TD>
                    <TD className="text-muted-foreground">{account.industry ?? '—'}</TD>
                    <TD className="text-muted-foreground">
                      {[account.city, account.country].filter(Boolean).join(', ') || '—'}
                    </TD>
                    <TD className="text-right tabular-nums">{account._count.contacts}</TD>
                    <TD className="text-muted-foreground">{formatDate(account.createdAt)}</TD>
                    <TD className="text-right">
                      {can(PERMISSIONS.ACCOUNT_DELETE) ? (
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Delete ${account.name}`}
                          onClick={() =>
                            void confirm({
                              title: `Delete ${account.name}?`,
                              description: 'Its contacts stay, but lose their account link.',
                              confirmLabel: 'Delete account',
                              onConfirm: () => remove.mutateAsync(account.id),
                            })
                          }
                        >
                          <Trash2 className="h-4 w-4" aria-hidden />
                        </Button>
                      ) : null}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </DataTable>
            <Pagination meta={accounts.data.meta} onPageChange={setPage} />
          </>
        )}
      </Card>

      <AccountFormDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </>
  );
}
