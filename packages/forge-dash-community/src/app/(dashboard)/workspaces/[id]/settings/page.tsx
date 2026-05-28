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
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saved, setSaved] = useState(false);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load workspace
  useEffect(() => {
    fetch(`/api/hub/workspaces/${workspaceId}`)
      .then(async (res) => {
        if (!res.ok) { setLoadError(true); return; }
        const ws = (await res.json()) as HubWorkspace;
        setWorkspace(ws);
        setName(ws.name);
        setDescription(ws.description ?? '');
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

    const body: { name?: string; description?: string | null } = {};
    if (name.trim() !== workspace.name) body.name = name.trim();
    if (description.trim() !== (workspace.description ?? '')) {
      body.description = description.trim() || null;
    }

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
        setSaveError(res.status === 403 ? 'You do not have permission to edit this workspace.' : 'Save failed. Try again.');
        return;
      }
      // Update local state
      setWorkspace((prev) => prev ? { ...prev, ...body, description: body.description !== undefined ? (body.description ?? null) : prev.description } : prev);
      setSaved(true);
      if (savedTimerRef.current !== null) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => setSaved(false), 3000);
      // Refresh the page data if name changed (left-rail may need refresh)
      if (body.name) router.refresh();
    } catch {
      setSaveError('Save failed. Try again.');
    } finally {
      setSaving(false);
    }
  }

  const isOwnerOrAdmin = workspace?.role === 'owner' || workspace?.role === 'admin';

  if (loadError) {
    return (
      <div className="max-w-lg">
        <div className="flex items-center gap-3 mb-8">
          <h1 className="font-mono text-[18px] font-bold">Settings</h1>
        </div>
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
      {/* Page header */}
      <div className="flex items-center gap-3 mb-8">
        <h1 className="font-mono text-[18px] font-bold">Settings</h1>
        {workspace && (
          <span
            className="font-mono text-[11px]"
            style={{ color: 'rgba(245,240,235,0.3)' }}
          >
            {workspace.slug}
          </span>
        )}
      </div>

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
            className="rounded-[10px] px-5 py-5"
            style={{
              background: '#111116',
              border: '1px solid rgba(248,113,113,0.2)',
            }}
          >
            <p
              className="font-mono text-[11px] mb-3"
              style={{ color: 'rgba(245,240,235,0.45)' }}
            >
              Workspace deletion is not available from the dashboard. Use the hub API directly
              if you need to archive this workspace.
            </p>
          </div>
        </section>
      )}
    </div>
  );
}
