'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ApiError } from '@/lib/api-client';
import { portalService } from '@/services/portal.service';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/input';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { Pagination } from '@/components/ui/pagination';
import { ArticleSearch } from '@/components/portal/article-search';

export default function PortalKnowledgeBase({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const api = portalService(slug);
  const searchParams = useSearchParams();
  const [categoryId, setCategoryId] = useState(searchParams.get('category') ?? '');
  const [page, setPage] = useState(1);

  const categories = useQuery({ queryKey: ['portal-categories', slug], queryFn: api.categories });
  const articles = useQuery({
    queryKey: ['portal-articles', slug, { categoryId, page }],
    queryFn: () => api.articles({ page, pageSize: 10, ...(categoryId ? { categoryId } : {}) }),
  });

  return (
    <>
      <div className="space-y-3">
        <h1 className="text-lg font-semibold tracking-tight">Knowledge base</h1>
        <ArticleSearch slug={slug} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Select
          className="w-full sm:w-64"
          value={categoryId}
          aria-label="Filter by category"
          onChange={(event) => {
            setPage(1);
            setCategoryId(event.target.value);
          }}
        >
          <option value="">All categories</option>
          {(categories.data ?? []).map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </Select>
      </div>

      {articles.isPending ? (
        <LoadingState />
      ) : articles.isError ? (
        <ErrorState
          message={
            articles.error instanceof ApiError ? articles.error.message : 'Unable to load articles.'
          }
          onRetry={() => articles.refetch()}
        />
      ) : articles.data && articles.data.items.length > 0 ? (
        <>
          <div className="space-y-3">
            {articles.data.items.map((article) => (
              <Card key={article.id}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-md">
                    <Link className="hover:underline" href={`/help/${slug}/kb/${article.slug}`}>
                      {article.title}
                    </Link>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-1 text-base text-muted-foreground">
                  {article.summary ? <p>{article.summary}</p> : null}
                  <p className="text-xs">
                    {article.category ? `${article.category.name} · ` : ''}
                    {article.viewCount} view(s)
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>
          <Pagination meta={articles.data.meta} onPageChange={setPage} />
        </>
      ) : (
        <EmptyState title="Nothing published here yet" description="Check back soon, or raise a request instead." />
      )}
    </>
  );
}
