import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  hubFetch,
  type DocCategory,
  type HubWorkspace,
  type HubWorkspaceDoc,
} from '@/lib/hub';
import { getSessionCookie, SESSION_COOKIE } from '@/lib/session';

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ category?: string; status?: string }>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CATEGORIES: { id: DocCategory; label: string }[] = [
  { id: 'architecture', label: 'Architecture' },
  { id: 'adr',         label: 'ADRs' },
  { id: 'api',         label: 'API' },
  { id: 'pattern',     label: 'Patterns' },
  { id: 'agent',       label: 'Agents' },
  { id: 'feature',     label: 'Features' },
  { id: 'runbook',     label: 'Runbooks' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statusBadge(status: string): React.ReactElement {
  const styles: Record<string, string> = {
    active:     'bg-green-500/20 text-green-300 border-green-500/30',
    archived:   'bg-white/10 text-white/40 border-white/10',
    superseded: 'bg-yellow-500/20 text-yellow-300 border-yellow-500/30',
  };
  const cls = styles[status] ?? 'bg-white/10 text-white/40 border-white/10';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-mono border ${cls}`}>
      {status}
    </span>
  );
}

function formatUpdatedBy(updatedBy: string): string {
  if (updatedBy.startsWith('user:')) return updatedBy.slice(5);
  if (updatedBy.startsWith('device:')) return updatedBy.slice(7);
  return updatedBy;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function KnowledgePage({ params, searchParams }: Props) {
  const { id: workspaceId } = await params;
  const { category: rawCategory, status: rawStatus } = await searchParams;

  const session = await getSessionCookie();
  if (!session) redirect('/login');

  const cookieHeader = `${SESSION_COOKIE}=${session}`;

  const activeCategory = CATEGORIES.some(c => c.id === rawCategory)
    ? (rawCategory as DocCategory)
    : null;
  const showAll = rawStatus === 'all';

  // Build query params for hub fetch
  const queryParts: string[] = [];
  if (activeCategory) queryParts.push(`category=${activeCategory}`);
  queryParts.push(`status=${showAll ? 'all' : 'active'}`);

  // Fetch workspace info + docs in parallel
  const [wsRes, docsRes] = await Promise.all([
    hubFetch<HubWorkspace>(`/workspaces/${workspaceId}`, { cookie: cookieHeader }),
    hubFetch<{ docs: HubWorkspaceDoc[] }>(
      `/workspaces/${workspaceId}/docs?${queryParts.join('&')}`,
      { cookie: cookieHeader },
    ),
  ]);

  if (!wsRes.ok) redirect('/workspaces');

  const docs = docsRes.ok ? docsRes.data.docs : [];

  const base = `/workspaces/${workspaceId}`;

  return (
    <div className="flex flex-col gap-6">
      {/* Show all / active toggle */}
      <div className="flex items-center justify-end gap-2 text-sm">
        <Link
          href={`${base}/knowledge${activeCategory ? `?category=${activeCategory}` : ''}`}
          className={`rounded-lg px-3 py-1.5 transition-colors ${
            !showAll
              ? 'bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100'
              : 'text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100'
          }`}
        >
          Active
        </Link>
        <Link
          href={`${base}/knowledge?${activeCategory ? `category=${activeCategory}&` : ''}status=all`}
          className={`rounded-lg px-3 py-1.5 transition-colors ${
            showAll
              ? 'bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100'
              : 'text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100'
          }`}
        >
          All
        </Link>
      </div>

      {/* Category tabs */}
      <div className="flex gap-1 flex-wrap">
        <Link
          href={`${base}/knowledge${showAll ? '?status=all' : ''}`}
          className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${
            activeCategory === null
              ? 'bg-[#FF6B2B]/20 text-[#FF6B2B] border border-[#FF6B2B]/30'
              : 'text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 border border-white/[0.06] hover:border-white/[0.12]'
          }`}
        >
          All
        </Link>
        {CATEGORIES.map(cat => (
          <Link
            key={cat.id}
            href={`${base}/knowledge?category=${cat.id}${showAll ? '&status=all' : ''}`}
            className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${
              activeCategory === cat.id
                ? 'bg-[#FF6B2B]/20 text-[#FF6B2B] border border-[#FF6B2B]/30'
                : 'text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 border border-white/[0.06] hover:border-white/[0.12]'
            }`}
          >
            {cat.label}
          </Link>
        ))}
      </div>

      {/* Doc count */}
      <p className="text-sm text-white/40">
        {docs.length === 0
          ? 'No docs found'
          : `${docs.length} doc${docs.length !== 1 ? 's' : ''}`}
      </p>

      {/* Doc grid */}
      {docs.length === 0 ? (
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-10 text-center">
          <p className="text-white/30 text-sm">
            {activeCategory
              ? `No ${activeCategory} docs yet`
              : 'No docs in this workspace yet'}
          </p>
          <p className="text-white/20 text-xs mt-1">
            Scribe creates docs automatically when agents complete significant tasks.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {docs.map(doc => (
            <DocCard key={doc.id} doc={doc} workspaceId={workspaceId} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DocCard — collapsible doc viewer
// ---------------------------------------------------------------------------

function DocCard({ doc, workspaceId: _workspaceId }: { doc: HubWorkspaceDoc; workspaceId: string }): React.ReactElement {
  const dimmed = doc.status !== 'active';

  return (
    <details
      className={`group rounded-xl border transition-colors ${
        dimmed
          ? 'border-white/[0.04] bg-white/[0.01] opacity-60'
          : 'border-white/[0.06] bg-white/[0.02] hover:border-white/[0.10] hover:bg-white/[0.04]'
      }`}
    >
      <summary className="flex items-start justify-between gap-4 p-4 cursor-pointer list-none select-none">
        <div className="flex flex-col gap-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm leading-tight truncate">{doc.title}</span>
            {statusBadge(doc.status)}
            <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-mono border border-white/[0.08] text-white/30">
              {doc.category}
            </span>
          </div>
          <div className="flex items-center gap-3 text-[11px] text-white/30 font-mono">
            <span>{doc.key}</span>
            <span>·</span>
            <span>Updated by {formatUpdatedBy(doc.updatedBy)} on {formatDate(doc.updatedAt)}</span>
          </div>
          {doc.status === 'superseded' && doc.supersededReason && (
            <p className="text-[11px] text-yellow-400/60 mt-0.5">
              ⚠ Superseded: {doc.supersededReason}
            </p>
          )}
        </div>
        <span className="text-white/20 text-xs shrink-0 pt-0.5 group-open:rotate-90 transition-transform">▶</span>
      </summary>

      {/* Expanded: doc content */}
      <div className="px-4 pb-4">
        <div className="border-t border-white/[0.06] pt-3">
          <div className="text-[13px] text-white/65 whitespace-pre-wrap leading-relaxed">
            {doc.content}
          </div>
        </div>
      </div>
    </details>
  );
}
