import Link from 'next/link';
import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { hubFetch, type HubWorkspace } from '@/lib/hub';
import { getSessionCookie, SESSION_COOKIE } from '@/lib/session';
import { NewWorkspaceButton, GitBranchIcon } from './new-workspace-button';

/** "github.com/org/repo" from an https clone URL, for a compact card label. */
function repoLabel(url: string): string {
  return url.replace(/^https:\/\//i, '').replace(/\.git$/, '');
}

/** Compact relative age, e.g. "today", "3d", "5mo", "2y". */
function relativeAge(iso: string): string {
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (Number.isNaN(d) || d <= 0) return 'today';
  if (d === 1) return '1d';
  if (d < 30) return `${d}d`;
  if (d < 365) return `${Math.floor(d / 30)}mo`;
  return `${Math.floor(d / 365)}y`;
}

function PencilIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

export default async function WorkspacesPage() {
  const session = await getSessionCookie();
  if (!session) redirect('/login');

  const res = await hubFetch<{ workspaces: HubWorkspace[] }>('/workspaces', {
    cookie: `${SESSION_COOKIE}=${session}`,
  });
  const workspaces = res.ok ? res.data.workspaces : [];

  // Active first, newest within each group.
  const ordered = [...workspaces].sort((a, b) => {
    const aArch = a.status === 'archived' ? 1 : 0;
    const bArch = b.status === 'archived' ? 1 : 0;
    if (aArch !== bArch) return aArch - bArch;
    return b.createdAt.localeCompare(a.createdAt);
  });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Workspaces</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
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
        <div className="flex flex-col items-center gap-5 rounded-xl border border-dashed border-zinc-300 px-6 py-16 text-center dark:border-zinc-700/80">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[#FF6B2B]/10 text-[#FF6B2B]">
            <GitBranchIcon className="h-7 w-7" />
          </span>
          <div className="space-y-1.5">
            <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
              Create your first workspace
            </h2>
            <p className="mx-auto max-w-sm text-sm text-zinc-500 dark:text-zinc-400">
              A workspace groups tasks for a project. Bind a git repo and its agents can check
              out the code, branch per task, and open pull requests.
            </p>
          </div>
          <Suspense>
            <NewWorkspaceButton />
          </Suspense>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {ordered.map((ws) => (
            <div
              key={ws.id}
              className={`group relative flex h-full flex-col overflow-hidden rounded-xl border bg-white dark:bg-zinc-900/70 border-zinc-200 dark:border-zinc-800 transition-all duration-150 hover:border-[#FF6B2B]/50 hover:shadow-md hover:shadow-black/5 hover:-translate-y-0.5 ${ws.status === 'archived' ? 'opacity-60 hover:opacity-90' : ''}`}
            >
              {/* status accent rail — emerald active, zinc archived */}
              <span
                className={`absolute inset-y-0 left-0 w-[3px] ${ws.status === 'archived' ? 'bg-zinc-400 dark:bg-zinc-600' : 'bg-emerald-500/80'}`}
                aria-hidden
              />

              {/* edit affordance — above the stretched card link */}
              <Link
                href={`/workspaces/${ws.id}/settings`}
                aria-label={`Edit ${ws.name}`}
                title="Edit workspace"
                className="absolute right-2 top-2 z-10 rounded-md p-1.5 text-zinc-400 opacity-0 transition-opacity hover:bg-zinc-100 hover:text-zinc-700 focus-visible:opacity-100 group-hover:opacity-100 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
              >
                <PencilIcon className="h-4 w-4" />
              </Link>

              <div className="flex flex-1 flex-col gap-1 p-4 pl-5">
                <div className="flex items-start gap-2 pr-6">
                  <h3 className="flex-1 min-w-0 truncate text-[15px] font-semibold leading-tight text-zinc-900 dark:text-zinc-100">
                    {/* stretched link — whole card navigates to the workspace */}
                    <Link
                      href={`/workspaces/${ws.id}`}
                      className="outline-none after:absolute after:inset-0 focus-visible:underline"
                    >
                      {ws.name}
                    </Link>
                  </h3>
                  {ws.status === 'archived' && (
                    <span className="shrink-0 rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                      archived
                    </span>
                  )}
                </div>
                <p className="font-mono text-[11px] text-zinc-400 dark:text-zinc-500">{ws.slug}</p>

                {ws.description ? (
                  <p className="mt-1.5 line-clamp-2 text-[13px] leading-relaxed text-zinc-600 dark:text-zinc-400">
                    {ws.description}
                  </p>
                ) : (
                  <p className="mt-1.5 text-[13px] italic text-zinc-400 dark:text-zinc-600">No description</p>
                )}

                <div className="mt-auto flex items-center gap-2 border-t border-zinc-100 pt-3 dark:border-zinc-800/80">
                  <span className="inline-flex items-center gap-1.5 rounded-md bg-zinc-100 px-2 py-1 text-[11px] font-medium capitalize text-zinc-600 dark:bg-zinc-800/80 dark:text-zinc-300">
                    <span className={`h-1.5 w-1.5 rounded-full ${ws.role === 'owner' || ws.role === 'admin' ? 'bg-[#FF6B2B]' : 'bg-zinc-400 dark:bg-zinc-500'}`} />
                    {ws.role}
                  </span>
                  {ws.repoUrl && (
                    <span
                      title={ws.repoUrl}
                      className="inline-flex min-w-0 items-center gap-1.5 rounded-md border border-[#FF6B2B]/30 bg-[#FF6B2B]/[0.08] px-2 py-1 text-[11px] font-medium text-[#FF6B2B]"
                    >
                      <GitBranchIcon className="h-3 w-3 shrink-0" />
                      <span className="truncate">{repoLabel(ws.repoUrl)}</span>
                    </span>
                  )}
                  <span className="ml-auto shrink-0 text-[11px] text-zinc-400 dark:text-zinc-600">
                    {relativeAge(ws.createdAt)}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
