import { redirect } from 'next/navigation';
import Link from 'next/link';
import { hubFetch, type HubMe, type HubWorkspace } from '@/lib/hub';
import { getSessionCookie, SESSION_COOKIE } from '@/lib/session';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return 'unknown date';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function RoleBadge({ role }: { role: string }) {
  const isAdmin = role === 'admin' || role === 'owner';
  return (
    <span
      className="font-mono text-[10px] px-1.5 py-0.5 rounded flex-shrink-0"
      style={{
        color: isAdmin ? '#A78BFA' : 'rgba(245,240,235,0.4)',
        background: isAdmin ? 'rgba(167,139,250,0.12)' : 'rgba(255,255,255,0.06)',
      }}
    >
      {role}
    </span>
  );
}

interface WorkspaceMemberRowProps {
  workspace: HubWorkspace;
  isLast: boolean;
}

function WorkspaceMemberRow({ workspace, isLast }: WorkspaceMemberRowProps) {
  return (
    <li
      className="flex items-center gap-4 px-5 py-3.5"
      style={{
        borderBottom: isLast ? 'none' : '1px solid rgba(255,255,255,0.04)',
      }}
    >
      <div className="flex-1 min-w-0">
        <div
          className="text-sm font-medium truncate"
          style={{ color: 'rgba(245,240,235,0.85)' }}
        >
          <Link
            href={`/workspaces/${workspace.id}`}
            className="hover:underline"
            style={{ color: 'inherit' }}
          >
            {workspace.name}
          </Link>
        </div>
        <div
          className="font-mono text-[10px] mt-0.5"
          style={{ color: 'rgba(245,240,235,0.25)' }}
        >
          {workspace.slug} &middot; since {formatDate(workspace.createdAt)}
        </div>
      </div>
      <RoleBadge role={workspace.role} />
    </li>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function OrgPage() {
  const session = await getSessionCookie();
  if (!session) redirect('/login');

  const cookieHeader = `${SESSION_COOKIE}=${session}`;
  const [meRes, workspacesRes] = await Promise.all([
    hubFetch<HubMe>('/auth/me', { cookie: cookieHeader }),
    hubFetch<{ workspaces: HubWorkspace[] }>('/workspaces', { cookie: cookieHeader }),
  ]);

  if (!meRes.ok) redirect('/login');

  const me = meRes.data;
  const workspaces = workspacesRes.ok ? (workspacesRes.data?.workspaces ?? []) : [];
  const workspacesFetchFailed = !workspacesRes.ok;

  return (
    <div className="max-w-2xl">
      {/* Page header */}
      <div className="flex items-center gap-3 mb-8">
        <h1 className="font-mono text-[18px] font-bold">Org</h1>
      </div>

      {/* User profile card */}
      <section className="mb-8">
        <h2
          className="font-mono text-[13px] font-semibold mb-3"
          style={{ color: 'rgba(245,240,235,0.6)' }}
        >
          Your account
        </h2>
        <div
          className="rounded-[10px] px-5 py-5"
          style={{ background: '#111116', border: '1px solid rgba(255,255,255,0.06)' }}
        >
          <div className="flex items-start justify-between gap-4">
            {/* Avatar initial */}
            <div
              className="flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center font-mono text-[15px] font-bold"
              style={{
                background: 'rgba(167,139,250,0.15)',
                color: '#A78BFA',
              }}
            >
              {(me.email[0] ?? '?').toUpperCase()}
            </div>

            <div className="flex-1 min-w-0">
              <div
                className="text-sm font-medium truncate"
                style={{ color: 'rgba(245,240,235,0.85)' }}
              >
                {me.email}
              </div>
              <div
                className="font-mono text-[11px] mt-0.5"
                style={{ color: 'rgba(245,240,235,0.3)' }}
              >
                ID: {me.id}
              </div>
            </div>

            <RoleBadge role={me.role} />
          </div>
        </div>
      </section>

      {/* Workspace memberships */}
      <section>
        <div className="flex items-center gap-3 mb-3">
          <h2
            className="font-mono text-[13px] font-semibold"
            style={{ color: 'rgba(245,240,235,0.6)' }}
          >
            Workspaces
          </h2>
          {workspaces.length > 0 && (
            <span
              className="font-mono text-[10px]"
              style={{ color: 'rgba(245,240,235,0.25)' }}
            >
              {workspaces.length} membership{workspaces.length !== 1 ? 's' : ''}
            </span>
          )}
        </div>

        <div
          className="rounded-[10px] overflow-hidden"
          style={{ background: '#111116', border: '1px solid rgba(255,255,255,0.06)' }}
        >
          {workspacesFetchFailed ? (
            <div className="px-5 py-10 text-center">
              <p className="text-[13px]" style={{ color: 'rgba(255,80,80,0.7)' }}>
                Could not load workspaces. Hub may be unreachable.
              </p>
            </div>
          ) : workspaces.length === 0 ? (
            <div className="px-5 py-10 text-center">
              <p className="text-[13px] mb-2" style={{ color: 'rgba(245,240,235,0.3)' }}>
                No workspace memberships yet.
              </p>
              <p className="font-mono text-[11px]" style={{ color: 'rgba(245,240,235,0.18)' }}>
                Create a workspace to get started.
              </p>
            </div>
          ) : (
            <ul>
              {workspaces.map((ws, i) => (
                <WorkspaceMemberRow
                  key={ws.id}
                  workspace={ws}
                  isLast={i === workspaces.length - 1}
                />
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
