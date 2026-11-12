'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { portalService } from '@/services/portal.service';
import { Input } from '@/components/ui/input';

/**
 * Search box with live results. Used on the help center home page and, on the request
 * form, as deflection: the answer may already be written down.
 */
export function ArticleSearch({
  slug,
  placeholder = 'Search for an answer…',
  initialQuery = '',
  label = 'Search the knowledge base',
}: {
  slug: string;
  placeholder?: string;
  initialQuery?: string;
  label?: string;
}) {
  const [term, setTerm] = useState(initialQuery);
  const [debounced, setDebounced] = useState(initialQuery);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(term.trim()), 250);
    return () => clearTimeout(timer);
  }, [term]);

  const results = useQuery({
    queryKey: ['portal-search', slug, debounced],
    queryFn: () => portalService(slug).search(debounced),
    enabled: debounced.length >= 2,
  });

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          className="h-11 pl-9"
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          placeholder={placeholder}
          aria-label={label}
        />
      </div>

      {debounced.length >= 2 ? (
        <div className="rounded-md border border-border bg-background">
          {results.isPending ? (
            <p className="px-3 py-3 text-base text-muted-foreground">Searching…</p>
          ) : results.data && results.data.length > 0 ? (
            <ul className="divide-y divide-border">
              {results.data.map((article) => (
                <li key={article.id}>
                  <Link className="block px-3 py-2 hover:bg-surface-muted" href={`/help/${slug}/kb/${article.slug}`}>
                    <span className="text-base font-medium">{article.title}</span>
                    {article.summary ? (
                      <span className="block truncate text-xs text-muted-foreground">{article.summary}</span>
                    ) : null}
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-3 py-3 text-base text-muted-foreground">
              Nothing matched “{debounced}”. Raising a request is the next best step.
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}
