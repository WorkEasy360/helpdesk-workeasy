import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { FULL_PRODUCT_NAME } from '@/components/brand/logo';
import { Providers } from '@/components/providers';
import { themeInitScript } from '@/components/theme-provider';

// Tokens, then the `c-*` classes, then Tailwind's layers. The order is the cascade:
// a utility on an element always wins over a `c-*` class. See docs/DESIGN-SYSTEM.md.
import './tokens.css';
import './components.css';
import './globals.css';

/**
 * Inter, self-hosted by next/font so there is no request to a font CDN and no layout
 * shift. Exposed as `--font-inter`, which is what the `sans` family reads.
 */
const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter',
});

export const metadata: Metadata = {
  title: { default: FULL_PRODUCT_NAME, template: `%s · ${FULL_PRODUCT_NAME}` },
  description: 'Multi-tenant customer support platform.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable} suppressHydrationWarning>
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
