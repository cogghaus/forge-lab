import { Card, CardBody, Chip } from '@heroui/react';
import Link from 'next/link';
import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { hubFetch, type HubWorkspace } from '@/lib/hub';
import { getSessionCookie, SESSION_COOKIE } from '@/lib/session';
import { NewWorkspaceButton } from './new-workspace-button';

/** "github.com/org/repo" from an https clone URL, for a compact card label. */
function repoLabel(url: string): string {
  return url.replace(/^https:\/\//i, '').replace(/\.git$/, '');
}

export default async function WorkspacesPage() {
  const session = await getSessionCookie();
  if (!session) redirect('/login');

  const res = await hubFetch<{ workspaces: HubWorkspace[] }>('/workspaces', {
    cookie: `${SESSION_COOKIE}=${session}`,
  });

  const workspaces = res.ok ? res.data.workspaces : [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Workspaces</h1>
          <p className="text-sm text-default-500">
            {workspaces.length > 0
              ? `${workspaces.length} workspace${workspaces.length === 1 ? '' : 's'} — select one to view its tasks`
              : 'Select a workspace to view its tasks'}
          </p>
        </div>
        <Suspense>
          <NewWorkspaceButton />
        </Suspense>
      </div>

      {workspaces.length === 0 ? (
        <Card>
          <CardBody className="py-14 flex flex-col items-center gap-4 text-center">
            <p className="text-default-500">No workspaces yet.</p>
            <p className="text-sm text-default-400 max-w-sm">
              A workspace groups tasks for a project. Bind a git repo to let its agents open
              pull requests.
            </p>
            <Suspense>
              <NewWorkspaceButton />
            </Suspense>
          </CardBody>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {workspaces.map((ws) => (
            <Card
              key={ws.id}
              as={Link}
              href={`/workspaces/${ws.id}`}
              isPressable
              className={`h-full ${ws.status === 'archived' ? 'opacity-60' : ''}`}
            >
              <CardBody className="gap-1">
                <div className="flex items-center gap-2">
                  <p className="font-semibold flex-1 min-w-0 truncate">{ws.name}</p>
                  {ws.status === 'archived' && (
                    <Chip size="sm" variant="flat" color="default" className="shrink-0">
                      archived
                    </Chip>
                  )}
                </div>
                <p className="text-xs text-default-400">{ws.slug}</p>
                {ws.description && (
                  <p className="mt-1 text-sm text-default-500 line-clamp-2">{ws.description}</p>
                )}
                <div className="mt-2 flex items-center gap-2 flex-wrap">
                  <Chip size="sm" variant="flat" color="default" className="capitalize">
                    {ws.role}
                  </Chip>
                  {ws.repoUrl && (
                    <Chip
                      size="sm"
                      variant="flat"
                      color="primary"
                      title={ws.repoUrl}
                      className="max-w-full"
                    >
                      <span className="truncate">⎇ {repoLabel(ws.repoUrl)}</span>
                    </Chip>
                  )}
                </div>
              </CardBody>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
