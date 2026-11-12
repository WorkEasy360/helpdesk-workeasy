'use client';

import { use } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, BookOpen, MessagesSquare, Ticket } from 'lucide-react';
import { portalService } from '@/services/portal.service';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { LoadingState } from '@/components/ui/states';
import { ArticleSearch } from '@/components/portal/article-search';
import { usePortalSession } from '@/components/portal/portal-session';

export default function HelpCenterHome({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const api = portalService(slug);
  const session = usePortalSession();

  const config = useQuery({ queryKey: ['portal-config', slug], queryFn: api.config });
  const categories = useQuery({
    queryKey: ['portal-categories', slug],
    queryFn: api.categories,
    enabled: config.data?.kbEnabled ?? false,
  });
  const popular = useQuery({
    queryKey: ['portal-articles', slug, 'popular'],
    queryFn: () => api.articles({ page: 1, pageSize: 5 }),
    enabled: config.data?.kbEnabled ?? false,
  });

  if (!config.data) {
    return <LoadingState />;
  }

  return (
    <>
      <section className="rounded-lg border border-border bg-background p-6">
        <h1 className="text-xl font-semibold tracking-tight">{config.data.name}</h1>
        {config.data.welcomeMessage ? (
          <p className="mt-1 text-base text-muted-foreground">{config.data.welcomeMessage}</p>
        ) : null}
        {config.data.kbEnabled ? (
          <div className="mt-4">
            <ArticleSearch slug={slug} />
          </div>
        ) : null}
      </section>

      <section className="grid gap-4 sm:grid-cols-3">
        {config.data.kbEnabled ? (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-md">
                <BookOpen className="h-4 w-4" aria-hidden />
                Knowledge base
              </CardTitle>
              <CardDescription>Guides and answers, written by the support team.</CardDescription>
            </CardHeader>
            <CardContent>
              <Link className="inline-flex items-center gap-1 text-base font-medium hover:underline" href={`/help/${slug}/kb`}>
                Browse articles <ArrowRight className="h-3.5 w-3.5" aria-hidden />
              </Link>
            </CardContent>
          </Card>
        ) : null}

        {config.data.allowTicketSubmission ? (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-md">
                <Ticket className="h-4 w-4" aria-hidden />
                Need a hand?
              </CardTitle>
              <CardDescription>Tell us what happened and we will pick it up.</CardDescription>
            </CardHeader>
            <CardContent>
              <Link
                className="inline-flex items-center gap-1 text-base font-medium hover:underline"
                href={`/help/${slug}/submit`}
              >
                Submit a request <ArrowRight className="h-3.5 w-3.5" aria-hidden />
              </Link>
            </CardContent>
          </Card>
        ) : null}

        {config.data.communityEnabled ? (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-md">
                <MessagesSquare className="h-4 w-4" aria-hidden />
                Community
              </CardTitle>
              <CardDescription>Ask other customers, share what worked.</CardDescription>
            </CardHeader>
            <CardContent>
              <Link
                className="inline-flex items-center gap-1 text-base font-medium hover:underline"
                href={`/help/${slug}/community`}
              >
                Join the discussion <ArrowRight className="h-3.5 w-3.5" aria-hidden />
              </Link>
            </CardContent>
          </Card>
        ) : null}
      </section>

      {config.data.kbEnabled ? (
        <section className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-md">Categories</CardTitle>
            </CardHeader>
            <CardContent>
              {categories.data && categories.data.length > 0 ? (
                <ul className="space-y-2">
                  {categories.data.map((category) => (
                    <li key={category.id}>
                      <Link className="text-base hover:underline" href={`/help/${slug}/kb?category=${category.id}`}>
                        {category.name}
                      </Link>
                      <span className="ml-2 text-xs text-muted-foreground">
                        {category._count.articles} article(s)
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-base text-muted-foreground">No categories published yet.</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-md">Most read</CardTitle>
            </CardHeader>
            <CardContent>
              {popular.data && popular.data.items.length > 0 ? (
                <ul className="space-y-2">
                  {popular.data.items.map((article) => (
                    <li key={article.id}>
                      <Link className="text-base hover:underline" href={`/help/${slug}/kb/${article.slug}`}>
                        {article.title}
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-base text-muted-foreground">No articles published yet.</p>
              )}
            </CardContent>
          </Card>
        </section>
      ) : null}

      {session.status === 'anonymous' ? (
        <p className="text-base text-muted-foreground">
          Already raised a request?{' '}
          <Link className="font-medium hover:underline" href={`/help/${slug}/login`}>
            Sign in
          </Link>{' '}
          to follow it.
        </p>
      ) : null}
    </>
  );
}
