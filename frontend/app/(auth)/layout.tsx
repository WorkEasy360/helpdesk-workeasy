import { BrandLockup } from '@/components/brand/logo';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <main id="main" className="w-full max-w-md">
        <div className="mb-6 flex justify-center">
          <BrandLockup />
        </div>
        {children}
      </main>
    </div>
  );
}
