import { redirect } from 'next/navigation';
import { hubFetch, type HubWorkspace } from '@/lib/hub';
import { getSessionCookie, SESSION_COOKIE } from '@/lib/session';
import { LeftRail } from './_components/left-rail';
import { TopBar } from './_components/top-bar';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getSessionCookie();
  if (!session) redirect('/login');

  const res = await hubFetch<{ workspaces: HubWorkspace[] }>('/workspaces', {
    cookie: `${SESSION_COOKIE}=${session}`,
  });
  const workspaces = res.ok ? res.data.workspaces : [];

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <TopBar workspaces={workspaces} />
      <div className="flex flex-1 min-h-0 overflow-hidden">
        <LeftRail workspaces={workspaces} />
        <main className="flex-1 overflow-y-auto min-w-0 p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
