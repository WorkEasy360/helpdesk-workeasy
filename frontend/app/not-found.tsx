import type { Metadata } from 'next';
import Link from 'next/link';
import { FileQuestion } from 'lucide-react';
import { Button } from '@/components/ui/button';

export const metadata: Metadata = { title: 'Page not found' };

export default function NotFound() {
  return (
    <main
      id="main"
      className="flex min-h-screen flex-col items-center justify-center gap-3 bg-background px-4 text-center text-foreground"
    >
      <FileQuestion className="h-10 w-10 text-muted-foreground" aria-hidden />
      <p className="text-sm font-medium text-muted-foreground">404</p>
      <h1 className="text-lg font-semibold tracking-tight">Page not found</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        The page you are looking for does not exist or has moved.
      </p>
      <div className="mt-2 flex flex-wrap justify-center gap-2">
        <Button asChild>
          <Link href="/dashboard">Go to dashboard</Link>
        </Button>
      </div>
    </main>
  );
}
