import { Card, CardBody } from '@heroui/react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { hubFetch, type HubWorkspace } from '@/lib/hub';
import { getSessionCookie, SESSION_COOKIE } from '@/lib/session';
import { NewWorkspaceButton } from './new-workspace-button';

export default async function WorkspacesPage() {
  const session = await getSessionCookie();
  if (!session) redirect('/login');

  const res = await hubFetch<{ workspaces: HubWorkspace[] }>('/workspaces', {
    cookie: `${SESSION_COOKIE}=${session}`,
  });

  const workspaces = res.ok ? res.data.workspaces : [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Workspaces</h1>
          <p className="text-sm text-default-500">Select a workspace to view its tasks</p>
        </div>
        <NewWorkspaceButton />
      </div>

      {workspaces.length === 0 ? (
        <Card>
          <CardBody className="py-12 text-center text-default-500">
            No workspaces yet. Create one to get started.
          </CardBody>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {workspaces.map((ws) => (
            <Link key={ws.id} href={`/workspaces/${ws.id}`}>
              <Card isPressable className="h-full">
                <CardBody className="gap-1">
                  <p className="font-semibold">{ws.name}</p>
                  <p className="text-xs text-default-400">{ws.slug}</p>
                  {ws.description && (
                    <p className="mt-1 text-sm text-default-500">{ws.description}</p>
                  )}
                  <p className="mt-2 text-xs text-default-400 capitalize">Role: {ws.role}</p>
                </CardBody>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
