import { redirect } from 'next/navigation';
import Link from 'next/link';
import { hubFetch, type HubWorkspace, type HubTaskStats } from '@/lib/hub';
import { getSessionCookie, SESSION_COOKIE } from '@/lib/session';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format positive cents as a USD dollar string. e.g. 5000 → "$50.00". 0 or negative → "Unlimited". */
function formatBudget(cents: number): string {
  if (cents <= 0) return 'Unlimited';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface WorkspaceBudgetRowProps {
  workspace: HubWorkspace;
  isLast: boolean;
}

function WorkspaceBudgetRow({ workspace, isLast }: WorkspaceBudgetRowProps) {
  const hasLimit = workspace.budgetMonthlyCents > 0;
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
          className="font-mono text-[10px] mt-0.5 capitalize"
          style={{ color: 'rgba(245,240,235,0.25)' }}
        >
          {workspace.role}
        </div>
      </div>

      <div className="text-right flex-shrink-0">
        <div
          className="font-mono text-sm font-semibold"
          style={{ color: hasLimit ? 'rgba(245,240,235,0.8)' : 'rgba(245,240,235,0.25)' }}
        >
          {formatBudget(workspace.budgetMonthlyCents)}
        </div>
        <div
          className="font-mono text-[10px]"
          style={{ color: 'rgba(245,240,235,0.2)' }}
        >
          /mo
        </div>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function CostsPage() {
  const session = await getSessionCookie();
  if (!session) redirect('/login');

  const cookieHeader = `${SESSION_COOKIE}=${session}`;
  const [workspacesRes, statsRes] = await Promise.all([
    hubFetch<{ workspaces: HubWorkspace[] }>('/workspaces', { cookie: cookieHeader }),
    hubFetch<HubTaskStats>('/tasks/stats', { cookie: cookieHeader }),
  ]);

  const fetchFailed = !workspacesRes.ok;
  // Use optional chaining: hubFetch can return { ok: true, data: null } if response body is empty
  const workspaces = workspacesRes.ok ? (workspacesRes.data?.workspaces ?? []) : [];
  const stats = statsRes.ok ? statsRes.data : null;

  // Total allocated budget across all workspaces with a limit set
  const totalBudgetCents = workspaces.reduce((sum, ws) => sum + ws.budgetMonthlyCents, 0);
  const budgetedWsCount = workspaces.filter((ws) => ws.budgetMonthlyCents > 0).length;

  return (
    <div className="max-w-2xl">
      {/* Page header */}
      <div className="flex items-center gap-3 mb-8">
        <h1 className="font-mono text-[18px] font-bold">Costs</h1>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        {/* Total budget */}
        <div
          className="rounded-[10px] px-4 py-4 flex flex-col gap-1"
          style={{ background: '#111116', border: '1px solid rgba(255,255,255,0.06)' }}
        >
          <span
            className="font-mono text-[10px] uppercase tracking-[0.08em]"
            style={{ color: 'rgba(245,240,235,0.35)' }}
          >
            Monthly budget
          </span>
          <span
            className="text-[22px] font-bold tabular-nums"
            style={{ color: 'rgba(245,240,235,0.9)' }}
          >
            {workspaces.length === 0
              ? '—'
              : budgetedWsCount === 0
                ? 'Unlimited'
                : formatBudget(totalBudgetCents)}
          </span>
          <span
            className="font-mono text-[10px]"
            style={{ color: 'rgba(245,240,235,0.2)' }}
          >
            {budgetedWsCount > 0
              ? `${budgetedWsCount} of ${workspaces.length} workspace${workspaces.length !== 1 ? 's' : ''} capped`
              : workspaces.length > 0
                ? 'no limits set'
                : 'no workspaces'}
          </span>
        </div>

        {/* Total tasks */}
        <div
          className="rounded-[10px] px-4 py-4 flex flex-col gap-1"
          style={{ background: '#111116', border: '1px solid rgba(255,255,255,0.06)' }}
        >
          <span
            className="font-mono text-[10px] uppercase tracking-[0.08em]"
            style={{ color: 'rgba(245,240,235,0.35)' }}
          >
            Total tasks
          </span>
          <span
            className="text-[22px] font-bold tabular-nums"
            style={{ color: 'rgba(245,240,235,0.9)' }}
          >
            {stats?.total ?? '—'}
          </span>
          <span
            className="font-mono text-[10px]"
            style={{ color: 'rgba(245,240,235,0.2)' }}
          >
            {stats ? `${stats.completionRate}% completed` : 'unavailable'}
          </span>
        </div>

        {/* Last 7 days */}
        <div
          className="rounded-[10px] px-4 py-4 flex flex-col gap-1"
          style={{ background: '#111116', border: '1px solid rgba(255,255,255,0.06)' }}
        >
          <span
            className="font-mono text-[10px] uppercase tracking-[0.08em]"
            style={{ color: 'rgba(245,240,235,0.35)' }}
          >
            Done last 7d
          </span>
          <span
            className="text-[22px] font-bold tabular-nums"
            style={{ color: stats && stats.completedLast7Days > 0 ? '#2DD4A0' : 'rgba(245,240,235,0.9)' }}
          >
            {stats?.completedLast7Days ?? '—'}
          </span>
          <span
            className="font-mono text-[10px]"
            style={{ color: 'rgba(245,240,235,0.2)' }}
          >
            completed tasks
          </span>
        </div>
      </div>

      {/* Workspace budget table */}
      <section className="mb-6">
        <h2
          className="font-mono text-[13px] font-semibold mb-3"
          style={{ color: 'rgba(245,240,235,0.6)' }}
        >
          Workspace budgets
        </h2>

        <div
          className="rounded-[10px] overflow-hidden"
          style={{ background: '#111116', border: '1px solid rgba(255,255,255,0.06)' }}
        >
          {fetchFailed ? (
            <div className="px-5 py-10 text-center">
              <p className="text-[13px]" style={{ color: 'rgba(255,80,80,0.7)' }}>
                Could not load workspaces. Hub may be unreachable.
              </p>
            </div>
          ) : workspaces.length === 0 ? (
            <div className="px-5 py-10 text-center">
              <p className="text-[13px] mb-2" style={{ color: 'rgba(245,240,235,0.3)' }}>
                No workspaces yet.
              </p>
              <p className="font-mono text-[11px]" style={{ color: 'rgba(245,240,235,0.18)' }}>
                Create a workspace to set a monthly budget.
              </p>
            </div>
          ) : (
            <ul>
              {workspaces.map((ws, i) => (
                <WorkspaceBudgetRow
                  key={ws.id}
                  workspace={ws}
                  isLast={i === workspaces.length - 1}
                />
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* Spend tracking note */}
      <section>
        <div
          className="rounded-[10px] px-5 py-4"
          style={{
            background: 'rgba(255,255,255,0.025)',
            border: '1px solid rgba(255,255,255,0.05)',
          }}
        >
          <p
            className="font-mono text-[11px] mb-1"
            style={{ color: 'rgba(245,240,235,0.4)' }}
          >
            Token spend tracking
          </p>
          <p
            className="font-mono text-[11px]"
            style={{ color: 'rgba(245,240,235,0.22)' }}
          >
            Per-task token usage and cost attribution appear here once agents report usage. Requires forge-daemon v2+ with token tracking enabled.
          </p>
        </div>
      </section>
    </div>
  );
}
