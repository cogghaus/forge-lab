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

  // Policy rules state
  type PolicyRule = { id: string; principal: string; action: string; effect: 'allow' | 'deny'; priority: number; resourceType: string | null };
  const [policyRules, setPolicyRules] = useState<PolicyRule[]>([]);
  const [ruleForm, setRuleForm] = useState({ principal: '', action: 'task:assign', effect: 'deny' as 'allow' | 'deny', priority: '100' });
  const [ruleCreating, setRuleCreating] = useState(false);
  const [ruleError, setRuleError] = useState('');

  // Context docs state
  type ContextDoc = { id: string; name: string; sizeBytes: number; updatedAt: number };
  const [contextDocs, setContextDocs] = useState<ContextDoc[]>([]);
  const [docForm, setDocForm] = useState({ name: '', content: '' });
  const [docSaving, setDocSaving] = useState(false);
  const [docError, setDocError] = useState('');

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

  useEffect(() => {
    fetch(`/api/hub/workspaces/${workspaceId}/policy-rules`)
      .then(async (res) => { if (res.ok) setPolicyRules(((await res.json()) as { rules: PolicyRule[] }).rules); })
      .catch(() => {});
  }, [workspaceId]);

  useEffect(() => {
    fetch(`/api/hub/workspaces/${workspaceId}/context-docs`)
      .then(async (res) => { if (res.ok) setContextDocs(((await res.json()) as { docs: ContextDoc[] }).docs); })
      .catch(() => {});
  }, [workspaceId]);

  async function handleCreateRule(e: React.FormEvent) {
    e.preventDefault();
    if (!ruleForm.principal.trim()) return;
    setRuleCreating(true); setRuleError('');
    try {
      const res = await fetch(`/api/hub/workspaces/${workspaceId}/policy-rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ principal: ruleForm.principal.trim(), action: ruleForm.action, effect: ruleForm.effect, priority: Number(ruleForm.priority) }),
      });
      if (!res.ok) { setRuleError('Failed to create rule'); return; }
      const { rule } = (await res.json()) as { rule: PolicyRule };
      setPolicyRules((prev) => [...prev, rule]);
      setRuleForm({ principal: '', action: 'task:assign', effect: 'deny', priority: '100' });
    } catch { setRuleError('Network error'); }
    finally { setRuleCreating(false); }
  }

  async function handleArchiveRule(ruleId: string) {
    try {
      const res = await fetch(`/api/hub/workspaces/${workspaceId}/policy-rules/${ruleId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archived: true }),
      });
      if (res.ok) setPolicyRules((prev) => prev.filter((r) => r.id !== ruleId));
    } catch { /* non-fatal */ }
  }

  async function handleUpsertDoc(e: React.FormEvent) {
    e.preventDefault();
    if (!docForm.name.trim() || !docForm.content.trim()) return;
    setDocSaving(true); setDocError('');
    try {
      const res = await fetch(`/api/hub/workspaces/${workspaceId}/context-docs/${encodeURIComponent(docForm.name.trim())}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: docForm.content }),
      });
      const json = await res.json() as Record<string, unknown>;
      if (!res.ok) {
        const err = json['error'] as string | undefined;
        setDocError(err === 'content_too_large' ? 'Content exceeds 10 000 bytes' : err === 'doc_limit_exceeded' ? 'Limit reached (10 docs max)' : 'Failed to save');
        return;
      }
      const doc = json['doc'] as ContextDoc;
      setContextDocs((prev) => {
        const idx = prev.findIndex((d) => d.name === docForm.name.trim());
        if (idx >= 0) { const next = [...prev]; next[idx] = doc; return next; }
        return [...prev, doc];
      });
      setDocForm({ name: '', content: '' });
    } catch { setDocError('Network error'); }
    finally { setDocSaving(false); }
  }

  async function handleDeleteDoc(name: string) {
    try {
      const res = await fetch(`/api/hub/workspaces/${workspaceId}/context-docs/${encodeURIComponent(name)}`, { method: 'DELETE' });
      if (res.ok) setContextDocs((prev) => prev.filter((d) => d.name !== name));
    } catch { /* non-fatal */ }
  }

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

      {/* Policy Rules */}
      <section>
        <h2 className="font-mono text-xs font-semibold uppercase tracking-widest mb-4" style={{ color: 'rgba(245,240,235,0.4)' }}>
          Policy Rules
        </h2>
        <div className="rounded-xl p-5 space-y-4" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
          <p className="font-mono text-[11px]" style={{ color: 'rgba(245,240,235,0.45)' }}>
            Workspace-scoped Heimdall overrides. Higher priority beats built-in rules.
          </p>

          {/* Existing rules */}
          {policyRules.length > 0 && (
            <div className="space-y-2">
              {policyRules.map((rule) => (
                <div key={rule.id} className="flex items-center justify-between rounded-lg px-3 py-2" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }}>
                  <span className="font-mono text-[11px]" style={{ color: 'rgba(245,240,235,0.7)' }}>
                    <span style={{ color: rule.effect === 'deny' ? '#F87171' : '#4ADE80' }}>{rule.effect}</span>
                    {' '}{rule.principal} {rule.action}{rule.resourceType ? ` (${rule.resourceType})` : ''}{' '}
                    <span style={{ color: 'rgba(245,240,235,0.35)' }}>@{rule.priority}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => { void handleArchiveRule(rule.id); }}
                    className="font-mono text-[10px] px-2 py-1 rounded transition-colors"
                    style={{ color: 'rgba(245,240,235,0.4)', background: 'transparent' }}
                  >
                    archive
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Create rule form */}
          <form onSubmit={(e) => { void handleCreateRule(e); }} className="flex flex-wrap gap-2 items-end">
            <input
              type="text"
              value={ruleForm.principal}
              onChange={(e) => setRuleForm((f) => ({ ...f, principal: e.target.value }))}
              placeholder="principal (e.g. agent:anvil)"
              className="px-3 py-2 rounded-md text-xs font-mono outline-none flex-1 min-w-40"
              style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: 'rgba(245,240,235,0.85)' }}
            />
            <select
              value={ruleForm.action}
              onChange={(e) => setRuleForm((f) => ({ ...f, action: e.target.value }))}
              className="px-3 py-2 rounded-md text-xs font-mono outline-none"
              style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: 'rgba(245,240,235,0.85)' }}
            >
              {['task:assign','task:claim','task:cancel','task:retry','doc:write','doc:update','doc:supersede','device:deregister','device:rotate-token'].map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
            <select
              value={ruleForm.effect}
              onChange={(e) => setRuleForm((f) => ({ ...f, effect: e.target.value as 'allow' | 'deny' }))}
              className="px-3 py-2 rounded-md text-xs font-mono outline-none"
              style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: 'rgba(245,240,235,0.85)' }}
            >
              <option value="deny">deny</option>
              <option value="allow">allow</option>
            </select>
            <input
              type="number"
              value={ruleForm.priority}
              onChange={(e) => setRuleForm((f) => ({ ...f, priority: e.target.value }))}
              placeholder="priority"
              min={0} max={999}
              className="w-20 px-3 py-2 rounded-md text-xs font-mono outline-none"
              style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: 'rgba(245,240,235,0.85)' }}
            />
            <button
              type="submit"
              disabled={ruleCreating || !ruleForm.principal.trim()}
              className="px-4 py-2 rounded-md text-xs font-mono transition-colors disabled:opacity-40"
              style={{ background: '#FF6B2B', color: '#1A1A1F' }}
            >
              {ruleCreating ? 'Adding...' : 'Add rule'}
            </button>
          </form>
          {ruleError && <span className="font-mono text-[11px]" style={{ color: '#F87171' }}>{ruleError}</span>}
        </div>
      </section>

      {/* Context Docs */}
      <section>
        <h2 className="font-mono text-xs font-semibold uppercase tracking-widest mb-4" style={{ color: 'rgba(245,240,235,0.4)' }}>
          Context Docs
        </h2>
        <div className="rounded-xl p-5 space-y-4" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
          <p className="font-mono text-[11px]" style={{ color: 'rgba(245,240,235,0.45)' }}>
            Named markdown blobs injected into agent task prompts at assignment time. Max 10 docs, 10 000 bytes each.
          </p>

          {contextDocs.length > 0 && (
            <div className="space-y-2">
              {contextDocs.map((doc) => (
                <div key={doc.id} className="flex items-center justify-between rounded-lg px-3 py-2" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }}>
                  <span className="font-mono text-[11px]" style={{ color: 'rgba(245,240,235,0.7)' }}>
                    {doc.name}
                    <span className="ml-2" style={{ color: 'rgba(245,240,235,0.35)' }}>{doc.sizeBytes} B</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => { if (window.confirm(`Delete "${doc.name}"?`)) void handleDeleteDoc(doc.name); }}
                    className="font-mono text-[10px] px-2 py-1 rounded transition-colors"
                    style={{ color: 'rgba(245,240,235,0.4)', background: 'transparent' }}
                  >
                    delete
                  </button>
                </div>
              ))}
            </div>
          )}

          <form onSubmit={(e) => { void handleUpsertDoc(e); }} className="flex flex-col gap-2">
            <input
              type="text"
              value={docForm.name}
              onChange={(e) => setDocForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="doc name (e.g. architecture)"
              className="px-3 py-2 rounded-md text-xs font-mono outline-none"
              style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: 'rgba(245,240,235,0.85)' }}
            />
            <textarea
              value={docForm.content}
              onChange={(e) => setDocForm((f) => ({ ...f, content: e.target.value }))}
              placeholder="markdown content..."
              rows={6}
              className="px-3 py-2 rounded-md text-xs font-mono outline-none resize-y"
              style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: 'rgba(245,240,235,0.85)' }}
            />
            <button
              type="submit"
              disabled={docSaving || !docForm.name.trim() || !docForm.content.trim()}
              className="self-start px-4 py-2 rounded-md text-xs font-mono transition-colors disabled:opacity-40"
              style={{ background: '#FF6B2B', color: '#1A1A1F' }}
            >
              {docSaving ? 'Saving...' : 'Save doc'}
            </button>
          </form>
          {docError && <span className="font-mono text-[11px]" style={{ color: '#F87171' }}>{docError}</span>}
        </div>
      </section>
    </div>
  );
}
