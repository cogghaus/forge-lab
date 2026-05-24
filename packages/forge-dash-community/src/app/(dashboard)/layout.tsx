import Link from 'next/link';
import { logoutAction } from '@/actions/auth';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-30 border-b border-white/5 bg-background/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-3">
          <Link href="/workspaces" className="flex items-center gap-3 hover:opacity-90 transition-opacity">
            <span className="text-2xl leading-none select-none">🔥</span>
            <span className="font-mono text-lg font-bold tracking-tight text-foreground">forge-lab</span>
            <span className="rounded px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider bg-white/[0.06] text-white/50">
              community
            </span>
          </Link>
          <form action={logoutAction}>
            <button
              type="submit"
              className="font-mono text-xs uppercase tracking-wider text-white/40 hover:text-white/70 transition-colors px-3 py-1.5 rounded hover:bg-white/5"
            >
              Sign out
            </button>
          </form>
        </div>
      </header>
      <main className="mx-auto w-full max-w-7xl flex-1 p-6">{children}</main>
    </div>
  );
}
