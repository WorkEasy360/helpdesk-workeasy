import type { Metadata } from 'next';
import { HelpCenterLayout } from '@/components/portal/help-center-layout';
import { fetchPortalConfig } from '@/lib/server-api';

type Params = Promise<{ slug: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug } = await params;
  const config = await fetchPortalConfig(slug);
  const name = config?.name ?? 'Help center';
  return {
    // `absolute` so the help center carries the customer's brand, not ours.
    title: { absolute: name, template: `%s · ${name}` },
    description: config?.tagline ?? `Support articles and help from ${name}.`,
    ...(config?.logoUrl ? { icons: { icon: config.logoUrl } } : {}),
  };
}

export default async function HelpCenterRootLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Params;
}) {
  const { slug } = await params;
  return <HelpCenterLayout slug={slug}>{children}</HelpCenterLayout>;
}
