'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import type { HubWorkspace } from '@/lib/hub';

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function WorkspaceSettingsPage() {
  const params = useParams<{ id: string }>();
  const workspaceId = params.id;
  const router = useRouter();

  const [workspace, setWorkspace] = useState<HubWorkspace | null>(null);
  const [loadError, setLoadError] = useState(false);

  // Form state
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [repoBranch, setRepoBranch] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saved, setSaved] = useState(false);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Danger-zone state
  const [dangerBusy, setDangerBusy] = useState(false);
  const [dangerError, setDangerError] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState('');

  // Load workspace
  useEffect(() => {
    fetch(`/api/hub/workspaces/${workspaceId}`)
      .then(async (res) => {
        if (!res.ok) { setLoadError(true); return; }
        const ws = (await res.json()) as HubWorkspace;
        setWorkspace(ws);
        setName(ws.name);
        setDescription(ws.description ?? '');
        setRepoUrl(ws.repoUrl ?? '');
        setRepoBranch(ws.repoBranch ?? '');
      })
      .catch(() => setLoadError(true));
  }, [workspaceId]);

  useEffect(() => {
    return () => {
      if (savedTimerRef.current !== null) clearTimeout(savedTimerRef.current);
    };
  }, []);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!workspace) return;
    setSaving(true);
    setSaveError('');
    setSaved(false);

    const trimmedRepo = repoUrl.trim();
    if (trimmedRepo && !/^https:\/\//i.test(trimmedRepo)) {
      setSaving(false);
      setSaveError('Repo URL must be an https:// URL.');
      return;
    }

    const body: {
      name?: string;
      description?: string | null;
      repoUrl?: string | null;
      repoBranch?: string | null;
    } = {};
    if (name.trim() !== workspace.name) body.name = name.trim();
    if (description.trim() !== (workspace.description ?? '')) {
      body.description = description.trim() || null;
    }
    if (trimmedRepo !== (workspace.repoUrl ?? '')) body.repoUrl = trimmedRepo || null;
    if (repoBranch.trim() !== (workspace.repoBranch ?? '')) body.repoBranch = repoBranch.trim() || null;

    if (Object.keys(body).length === 0) {
      setSaving(false);
      return; // nothing changed
    }

    try {
      const res = await fetch(`/api/hub/workspaces/${workspaceId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setSaveError(
          res.status === 403 ? 'You do not have permission to edit this workspace.'
          : res.status === 400 ? 'Invalid input — check the repo URL (https only) and branch.'
          : 'Save failed. Try again.',
        );
        return;
      }
      setWorkspace((prev) => (prev ? { ...prev, ...body } : prev));
      setSaved(true);
      if (savedTimerRef.current !== null) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => setSaved(false), 3000);
      if (body.name) router.refresh();
    } catch {
      setSaveError('Save failed. Try again.');
    } finally {
      setSaving(false);
    }
  }

  const isOwnerOrAdmin = workspace?.role === 'owner' || workspace?.role === 'admin';
  const isArchived = workspace?.status === 'archived';

  async function handleArchiveToggle() {
    if (!workspace) return;
    setDangerBusy(true);
    setDangerError('');
    const next = isArchived ? 'active' : 'archived';
    try {
      const res = await fetch(`/api/hub/workspaces/${workspaceId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: next }),
      });
      if (!res.ok) {
        setDangerError(res.status === 403 ? 'Owner/admin role required.' : 'Action failed. Try again.');
        return;
      }
      setWorkspace((prev) => (prev ? { ...prev, status: next } : prev));
      router.refresh();
    } catch {
      setDangerError('Action failed. Try again.');
    } finally {
      setDangerBusy(false);
    }
  }

  async function handleDelete() {
    if (!workspace || deleteConfirm.trim() !== workspace.slug) return;
    setDangerBusy(true);
    setDangerError('');
    try {
      const res = await fetch(`/api/hub/workspaces/${workspaceId}`, { method: 'DELETE' });
      if (!res.ok) {
        setDangerError(res.status === 403 ? 'Owner role required to delete.' : 'Delete failed. Try again.');
        return;
      }
      router.push('/workspaces');
      router.refresh();
    } catch {
      setDangerError('Delete failed. Try again.');
    } finally {
      setDangerBusy(false);
    }
  }

  if (loadError) {
    return (
      <div className="max-w-lg">
        <div
          className="rounded-[10px] px-5 py-10 text-center"
          style={{ background: '#111116', border: '1px solid rgba(255,255,255,0.06)' }}
        >
          <p className="text-[13px]" style={{ color: 'rgba(255,80,80,0.7)' }}>
            Could not load workspace. Hub may be unreachable.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-lg">
      {workspace && (
        <div className="mb-6 font-mono text-[11px]" style={{ color: 'rgba(245,240,235,0.3)' }}>
          {workspace.slug}
        </div>
      )}

      {/* General settings form */}
      <section className="mb-8">
        <h2
          className="font-mono text-[13px] font-semibold mb-3"
          style={{ color: 'rgba(245,240,235,0.6)' }}
        >
          General
        </h2>

        <div
          className="rounded-[10px] px-5 py-5"
          style={{ background: '#111116', border: '1px solid rgba(255,255,255,0.06)' }}
        >
          {!workspace ? (
            // Skeleton while loading
            <div className="flex flex-col gap-4">
              {[0, 1].map((i) => (
                <div key={i} className="h-9 rounded animate-pulse" style={{ background: 'rgba(255,255,255,0.06)' }} />
              ))}
            </div>
          ) : !isOwnerOrAdmin ? (
            <p className="font-mono text-[11px]" style={{ color: 'rgba(245,240,235,0.3)' }}>
              You need admin or owner role to edit workspace settings.
            </p>
          ) : (
            <form onSubmit={(e) => { void handleSave(e); }} className="flex flex-col gap-4">
              {/* Name field */}
              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="ws-name"
                  className="font-mono text-[10px] uppercase tracking-[0.08em]"
                  style={{ color: 'rgba(245,240,235,0.35)' }}
                >
                  Name
                </label>
                <input
                  id="ws-name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={100}
                  required
                  className="w-full px-3 py-2 rounded-md text-sm font-medium outline-none transition-colors"
                  style={{
                    background: 'rgba(255,255,255,0.05)',
                    border: '1px solid rgba(255,255,255,0.1)',
                    color: 'rgba(245,240,235,0.85)',
                  }}
                />
              </div>

              {/* Description field */}
              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="ws-desc"
                  className="font-mono text-[10px] uppercase tracking-[0.08em]"
                  style={{ color: 'rgba(245,240,235,0.35)' }}
                >
                  Description
                  <span className="ml-1 normal-case" style={{ color: 'rgba(245,240,235,0.2)' }}>
                    (optional)
                  </span>
                </label>
                <textarea
                  id="ws-desc"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  maxLength={500}
                  rows={3}
                  className="w-full px-3 py-2 rounded-md text-sm outline-none transition-colors resize-none"
                  style={{
                    background: 'rgba(255,255,255,0.05)',
                    border: '1px solid rgba(255,255,255,0.1)',
                    color: 'rgba(245,240,235,0.85)',
                  }}
                />
              </div>

              {/* Git repo binding */}
              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="ws-repo-url"
                  className="font-mono text-[10px] uppercase tracking-[0.08em]"
                  style={{ color: 'rgba(245,240,235,0.35)' }}
                >
                  Git repo URL
                  <span className="ml-1 normal-case" style={{ color: 'rgba(245,240,235,0.2)' }}>
                    (optional — agents check it out and open PRs)
                  </span>
                </label>
                <input
                  id="ws-repo-url"
                  type="text"
                  value={repoUrl}
                  onChange={(e) => setRepoUrl(e.target.value)}
                  placeholder="https://github.com/org/repo.git"
                  className="w-full px-3 py-2 rounded-md text-sm outline-none transition-colors"
                  style={{
                    background: 'rgba(255,255,255,0.05)',
                    border: '1px solid rgba(255,255,255,0.1)',
                    color: 'rgba(245,240,235,0.85)',
                  }}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="ws-repo-branch"
                  className="font-mono text-[10px] uppercase tracking-[0.08em]"
                  style={{ color: 'rgba(245,240,235,0.35)' }}
                >
                  Base branch
                  <span className="ml-1 normal-case" style={{ color: 'rgba(245,240,235,0.2)' }}>
                    (defaults to main)
                  </span>
                </label>
                <input
                  id="ws-repo-branch"
                  type="text"
                  value={repoBranch}
                  onChange={(e) => setRepoBranch(e.target.value)}
                  placeholder="main"
                  className="w-full px-3 py-2 rounded-md text-sm outline-none transition-colors"
                  style={{
                    background: 'rgba(255,255,255,0.05)',
                    border: '1px solid rgba(255,255,255,0.1)',
                    color: 'rgba(245,240,235,0.85)',
                  }}
                />
              </div>

              {/* Save button + feedback */}
              <div className="flex items-center gap-3 pt-1">
                <button
                  type="submit"
                  disabled={saving || !name.trim()}
                  className="font-mono text-[11px] px-4 py-2 rounded-md transition-colors disabled:opacity-40"
                  style={{ background: '#FF6B2B', color: '#fff' }}
                >
                  {saving ? 'Saving...' : 'Save changes'}
                </button>
                {saved && (
                  <span className="font-mono text-[11px]" style={{ color: '#2DD4A0' }}>
                    Saved
                  </span>
                )}
                {saveError && (
                  <span className="font-mono text-[11px]" style={{ color: '#F87171' }}>
                    {saveError}
                  </span>
                )}
              </div>
            </form>
          )}
        </div>
      </section>

      {/* Danger zone */}
      {isOwnerOrAdmin && (
        <section>
          <h2
            className="font-mono text-[13px] font-semibold mb-3"
            style={{ color: '#F87171' }}
          >
            Danger zone
          </h2>
          <div
            className="rounded-[10px] px-5 py-5 flex flex-col gap-5"
            style={{ background: '#111116', border: '1px solid rgba(248,113,113,0.2)' }}
          >
            {/* Archive / unarchive */}
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-[13px] font-medium" style={{ color: 'rgba(245,240,235,0.85)' }}>
                  {isArchived ? 'Unarchive workspace' : 'Archive workspace'}
                </p>
                <p className="font-mono text-[11px]" style={{ color: 'rgba(245,240,235,0.4)' }}>
                  {isArchived
                    ? 'Restore this workspace to active.'
                    : 'Hide it from the active list. Reversible; tasks and data are kept.'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => { void handleArchiveToggle(); }}
                disabled={dangerBusy}
                className="font-mono text-[11px] px-4 py-2 rounded-md transition-colors disabled:opacity-40 shrink-0"
                style={{ background: 'rgba(255,255,255,0.06)', color: 'rgba(245,240,235,0.8)', border: '1px solid rgba(255,255,255,0.12)' }}
              >
                {isArchived ? 'Unarchive' : 'Archive'}
              </button>
            </div>

            <div style={{ borderTop: '1px solid rgba(248,113,113,0.15)' }} />

            {/* Delete */}
            <div className="flex flex-col gap-2.5">
              <div>
                <p className="text-[13px] font-medium" style={{ color: '#F87171' }}>
                  Delete workspace
                </p>
                <p className="font-mono text-[11px]" style={{ color: 'rgba(245,240,235,0.4)' }}>
                  Permanently removes it from the dashboard. Type the slug{' '}
                  <span className="font-semibold" style={{ color: 'rgba(245,240,235,0.7)' }}>{workspace?.slug}</span>{' '}
                  to confirm.
                </p>
              </div>
              <div className="flex items-center gap-3">
                <input
                  type="text"
                  value={deleteConfirm}
                  onChange={(e) => setDeleteConfirm(e.target.value)}
                  placeholder={workspace?.slug}
                  className="flex-1 px-3 py-2 rounded-md text-sm font-mono outline-none"
                  style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(248,113,113,0.25)', color: 'rgba(245,240,235,0.85)' }}
                />
                <button
                  type="button"
                  onClick={() => { void handleDelete(); }}
                  disabled={dangerBusy || deleteConfirm.trim() !== workspace?.slug}
                  className="font-mono text-[11px] px-4 py-2 rounded-md transition-colors disabled:opacity-40 shrink-0"
                  style={{ background: '#F87171', color: '#1A1A1F' }}
                >
                  Delete
                </button>
              </div>
            </div>

            {dangerError && (
              <span className="font-mono text-[11px]" style={{ color: '#F87171' }}>{dangerError}</span>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
