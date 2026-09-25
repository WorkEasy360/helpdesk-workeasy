'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { PERMISSIONS } from '@digisoft/shared';
import { ApiError } from '@/lib/api-client';
import { contactsService } from '@/services/contacts.service';
import { useAuthStore } from '@/stores/auth.store';
import { formatDate } from '@/lib/utils';
import { PageHeader } from '@/components/layout/page-header';
import { ContactFormDialog } from '@/components/customers/contact-form-dialog';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { DataTable, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { Pagination } from '@/components/ui/pagination';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/ui/states';

export default function CustomersPage() {
  const can = useAuthStore((state) => state.can);
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);

  const params = useMemo(
    () => ({ page, pageSize: 25, q: query || undefined, sort: 'createdAt', order: 'desc' as const }),
    [page, query],
  );

  const contacts = useQuery({
    queryKey: ['contacts', params],
    queryFn: () => contactsService.list(params),
  });

  const remove = useMutation({
    mutationFn: (id: string) => contactsService.remove(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['contacts'] });
      toast.success('Contact deleted');
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : 'Unable to delete the contact.'),
  });

  return (
    <>
      <PageHeader
        title="Customers"
        description="People who contact your support team."
        actions={
          can(PERMISSIONS.CONTACT_CREATE) ? (
            <Button onClick={() => setDialogOpen(true)}>
              <Plus className="h-4 w-4" aria-hidden />
              New contact
            </Button>
          ) : null
        }
      />

      <form
        className="flex max-w-md items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setPage(1);
          setQuery(search.trim());
        }}
        role="search"
      >
        <label htmlFor="contact-search" className="sr-only">
          Search contacts
        </label>
        <Input
          id="contact-search"
          placeholder="Search by name, email or phone"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <Button type="submit" variant="outline">
          <Search className="h-4 w-4" aria-hidden />
          Search
        </Button>
      </form>

      <Card>
        {contacts.isPending ? (
          <TableSkeleton columns={5} />
        ) : contacts.isError ? (
          <ErrorState
            message={
              contacts.error instanceof ApiError
                ? contacts.error.message
                : 'Unable to load contacts.'
            }
            onRetry={() => contacts.refetch()}
          />
        ) : contacts.data.items.length === 0 ? (
          <EmptyState
            title={query ? 'No contacts match that search' : 'No contacts yet'}
            description={
              query
                ? 'Try a different name, email address or phone number.'
                : 'Add the first person your team supports.'
            }
            action={
              can(PERMISSIONS.CONTACT_CREATE) && !query ? (
                <Button onClick={() => setDialogOpen(true)}>New contact</Button>
              ) : null
            }
          />
        ) : (
          <>
            <DataTable>
              <THead>
                <TR>
                  <TH>Name</TH>
                  <TH>Email</TH>
                  <TH>Account</TH>
                  <TH>Status</TH>
                  <TH>Added</TH>
                  <TH><span className="sr-only">Actions</span></TH>
                </TR>
              </THead>
              <TBody>
                {contacts.data.items.map((contact) => (
                  <TR key={contact.id}>
                    <TD>
                      <Link href={`/customers/${contact.id}`} className="font-medium hover:underline">
                        {contact.firstName} {contact.lastName ?? ''}
                      </Link>
                      {contact.isVip ? (
                        <Badge variant="warning" className="ml-2">
                          VIP
                        </Badge>
                      ) : null}
                      {contact.jobTitle ? (
                        <p className="text-xs text-muted-foreground">{contact.jobTitle}</p>
                      ) : null}
                    </TD>
                    <TD className="text-muted-foreground">{contact.email ?? '—'}</TD>
                    <TD>
                      {contact.account ? (
                        <Link href={`/accounts/${contact.account.id}`} className="hover:underline">
                          {contact.account.name}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TD>
                    <TD>
                      <Badge variant={contact.status === 'ACTIVE' ? 'success' : 'default'}>
                        {contact.status.charAt(0) + contact.status.slice(1).toLowerCase()}
                      </Badge>
                    </TD>
                    <TD className="text-muted-foreground">{formatDate(contact.createdAt)}</TD>
                    <TD className="text-right">
                      {can(PERMISSIONS.CONTACT_DELETE) ? (
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Delete ${contact.firstName}`}
                          onClick={() =>
                            void confirm({
                              title: `Delete ${contact.firstName}?`,
                              description: 'This can be undone by an administrator.',
                              confirmLabel: 'Delete contact',
                              onConfirm: () => remove.mutateAsync(contact.id),
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
            <Pagination meta={contacts.data.meta} onPageChange={setPage} />
          </>
        )}
      </Card>

      <ContactFormDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </>
  );
}
