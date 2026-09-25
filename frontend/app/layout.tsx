import type { Metadata } from 'next';
import { Providers } from '@/components/providers';
import { themeInitScript } from '@/components/theme-provider';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Digisoft360 Help Desk', template: '%s · Digisoft360 Help Desk' },
  description: 'Multi-tenant customer support platform.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Applies the saved theme before first paint to avoid a light-mode flash. */}
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-foreground"
        >
          Skip to content
        </a>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
