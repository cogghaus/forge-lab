import { Button } from '@heroui/react';
import Link from 'next/link';
import { logoutAction } from '@/actions/auth';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-divider bg-content1 px-6 py-3">
        <div className="mx-auto flex max-w-5xl items-center justify-between">
          <Link href="/workspaces" className="text-lg font-bold text-foreground">
            Forge Lab
          </Link>
          <form action={logoutAction}>
            <Button type="submit" variant="light" size="sm">
              Sign out
            </Button>
          </form>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 p-6">{children}</main>
    </div>
  );
}
