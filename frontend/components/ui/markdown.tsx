'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';

/**
 * Renders article and community bodies. Raw HTML is never enabled, so stored content
 * cannot inject markup into the page it is shown on.
 */
export function Markdown({ content, className }: { content: string; className?: string }) {
  return (
    <div
      className={cn(
        'space-y-3 text-base leading-6 text-foreground',
        '[&_h1]:text-xl [&_h1]:font-semibold [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:font-semibold',
        '[&_h1]:mt-4 [&_h2]:mt-4 [&_h3]:mt-3',
        '[&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-1',
        '[&_a]:text-primary [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground',
        '[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-xs',
        '[&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3',
        '[&_table]:w-full [&_th]:border-b [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_td]:border-b [&_td]:border-border [&_td]:px-2 [&_td]:py-1',
        className,
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}
