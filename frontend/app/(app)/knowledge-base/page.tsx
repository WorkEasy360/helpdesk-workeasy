'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, FolderTree, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { ARTICLE_STATUSES, PERMISSIONS } from '@digisoft/shared';
import { ApiError } from '@/lib/api-client';
import { kbService } from '@/services/kb.service';
import { helpCenterService } from '@/services/help-center.service';
import { useAuthStore } from '@/stores/auth.store';
import { formatDateTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/input';
import { DataTable, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/ui/states';
import { Pagination } from '@/components/ui/pagination';
import { PageHeader } from '@/components/layout/page-header';
import { CategoryManager } from '@/components/kb/category-manager';

const STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Draft',
  PENDING_REVIEW: 'In review',
  PUBLISHED: 'Published',
  ARCHIVED: 'Archived',
};

export default function KnowledgeBasePage() {
  const queryClient = useQueryClient();
  const can = useAuthStore((state) => state.can);
  const manage = can(PERMISSIONS.KB_MANAGE);

  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [q, setQ] = useState('');
  const [categoriesOpen, setCategoriesOpen] = useState(false);

  const articles = useQuery({
    queryKey: ['kb-articles', { page, status, categoryId, q }],
    queryFn: () =>
      kbService.articles({
        page,
        pageSize: 20,
        ...(status ? { status: status as 'DRAFT' } : {}),
        ...(categoryId ? { categoryId } : {}),
        ...(q ? { q } : {}),
      }),
  });
  const categories = useQuery({ queryKey: ['kb-categories'], queryFn: kbService.categories });
  const helpCenter = useQuery({
    queryKey: ['help-center'],
    queryFn: helpCenterService.get,
    enabled: can(PERMISSIONS.PORTAL_READ),
  });

  const togglePublish = useMutation({
    mutationFn: (article: { id: string; status: string }) =>
      article.status === 'PUBLISHED' ? kbService.unpublish(article.id) : kbService.publish(article.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['kb-articles'] });
      toast.success('Article updated');
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Unable to update.'),
  });

  return (
    <>
      <PageHeader
        title="Knowledge base"
        description="Articles your customers read in the help center."
        actions={
          <>
            {helpCenter.data ? (
              <Button asChild variant="outline">
                <Link href={`/help/${helpCenter.data.slug}`} target="_blank">
                  <ExternalLink className="h-4 w-4" aria-hidden />
                  View help center
                </Link>
              </Button>
            ) : null}
            {manage ? (
              <>
                <Button variant="outline" onClick={() => setCategoriesOpen(true)}>
                  <FolderTree className="h-4 w-4" aria-hidden />
                  Categories
                </Button>
                <Button asChild>
                  <Link href="/knowledge-base/new">
                    <Plus className="h-4 w-4" aria-hidden />
                    New article
                  </Link>
                </Button>
              </>
            ) : null}
          </>
        }
      />

      <div className="flex flex-wrap gap-2">
        <Input
          className="w-full sm:w-64"
          placeholder="Search articles…"
          value={q}
          onChange={(event) => {
            setPage(1);
            setQ(event.target.value);
          }}
          aria-label="Search articles"
        />
        <Select
          className="w-full sm:w-44"
          value={status}
          aria-label="Filter by status"
          onChange={(event) => {
            setPage(1);
            setStatus(event.target.value);
          }}
        >
          <option value="">Any status</option>
          {ARTICLE_STATUSES.map((value) => (
            <option key={value} value={value}>
              {STATUS_LABELS[value]}
            </option>
          ))}
        </Select>
        <Select
          className="w-full sm:w-52"
          value={categoryId}
          aria-label="Filter by category"
          onChange={(event) => {
            setPage(1);
            setCategoryId(event.target.value);
          }}
        >
          <option value="">Any category</option>
          {(categories.data ?? []).map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </Select>
      </div>

      <Card>
        {articles.isPending ? (
          <TableSkeleton columns={5} />
        ) : articles.isError ? (
          <ErrorState
            message={articles.error instanceof ApiError ? articles.error.message : 'Unable to load articles.'}
            onRetry={() => articles.refetch()}
          />
        ) : articles.data.items.length === 0 ? (
          <EmptyState
            title="No articles yet"
            description="Write the answers your team repeats every week and let customers find them first."
            action={
              manage ? (
                <Button asChild>
                  <Link href="/knowledge-base/new">New article</Link>
                </Button>
              ) : null
            }
          />
        ) : (
          <>
            <DataTable>
              <THead>
                <TR>
                  <TH>Article</TH>
                  <TH>Category</TH>
                  <TH>Status</TH>
                  <TH className="text-right">Views</TH>
                  <TH className="text-right">Helpful</TH>
                  <TH>Updated</TH>
                  <TH>
                    <span className="sr-only">Manage</span>
                  </TH>
                </TR>
              </THead>
              <TBody>
                {articles.data.items.map((article) => (
                  <TR key={article.id}>
                    <TD>
                      <Link className="font-medium hover:underline" href={`/knowledge-base/${article.id}`}>
                        {article.title}
                      </Link>
                      {article.summary ? (
                        <p className="truncate text-xs text-muted-foreground">{article.summary}</p>
                      ) : null}
                    </TD>
                    <TD className="text-base text-muted-foreground">{article.category?.name ?? '—'}</TD>
                    <TD>
                      <Badge variant={article.status === 'PUBLISHED' ? 'success' : 'default'}>
                        {STATUS_LABELS[article.status]}
                      </Badge>
                    </TD>
                    <TD className="text-right text-base">{article.viewCount}</TD>
                    <TD className="text-right text-base">
                      {article.helpfulCount}/{article.helpfulCount + article.notHelpfulCount}
                    </TD>
                    <TD className="text-base text-muted-foreground">{formatDateTime(article.updatedAt)}</TD>
                    <TD className="text-right">
                      {manage ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => togglePublish.mutate({ id: article.id, status: article.status })}
                        >
                          {article.status === 'PUBLISHED' ? 'Unpublish' : 'Publish'}
                        </Button>
                      ) : null}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </DataTable>
            <Pagination meta={articles.data.meta} onPageChange={setPage} />
          </>
        )}
      </Card>

      <CategoryManager open={categoriesOpen} onOpenChange={setCategoriesOpen} />
    </>
  );
}
