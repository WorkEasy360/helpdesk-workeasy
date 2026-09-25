import type { Metadata } from 'next';
import { PortalArticleView } from '@/components/portal/article-view';
import { fetchPortalArticle } from '@/lib/server-api';

type Params = Promise<{ slug: string; articleSlug: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug, articleSlug } = await params;
  const article = await fetchPortalArticle(slug, articleSlug);
  if (!article) return { title: 'Article' };
  return {
    title: article.title,
    ...(article.summary ? { description: article.summary } : {}),
  };
}

export default async function PortalArticlePage({ params }: { params: Params }) {
  const { slug, articleSlug } = await params;
  return <PortalArticleView slug={slug} articleSlug={articleSlug} />;
}
