'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import type { HubDevice } from '@/lib/hub';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** A device is considered online if lastSeen within this many milliseconds. */
const ONLINE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isOnline(lastSeen: string | null): boolean {
  if (lastSeen === null) return false;
  const ms = new Date(lastSeen).getTime();
  if (isNaN(ms)) return false;
  return Date.now() - ms < ONLINE_THRESHOLD_MS;
}

function platformLabel(platform: string | null): string {
  if (!platform) return '';
  const p = platform.toLowerCase();
  if (p === 'win32' || p === 'windows') return 'win';
  if (p === 'darwin' || p === 'macos') return 'mac';
  if (p === 'linux') return 'linux';
  return platform;
}

// ---------------------------------------------------------------------------
// AgentDaemonsPanel — manage the agent daemon device registrations (rename,
// rotate token, deregister). Org-level: these are the daemons, not user logins.
// ---------------------------------------------------------------------------

export interface AgentDaemonsPanelProps {
  devices: HubDevice[];
}

export function AgentDaemonsPanel({ devices: initialDevices }: AgentDaemonsPanelProps) {
  const router = useRouter();
  const [devices, setDevices] = useState<HubDevice[]>(initialDevices);
  const [showDeregistered, setShowDeregistered] = useState(false);
  const [loadingDevices, setLoadingDevices] = useState(false);

  const fetchDevices = useCallback(async (withDeregistered: boolean) => {
    setLoadingDevices(true);
    try {
      const url = `/api/hub/devices${withDeregistered ? '?includeDeregistered=true' : ''}`;
      const res = await fetch(url);
      if (res.ok) {
        const data = (await res.json().catch(() => null)) as { devices: HubDevice[] } | null;
        if (data) setDevices(data.devices ?? []);
      }
    } finally {
      setLoadingDevices(false);
    }
  }, []);

  const toggleShowDeregistered = useCallback(async () => {
    const next = !showDeregistered;
    setShowDeregistered(next);
    await fetchDevices(next);
  }, [showDeregistered, fetchDevices]);

  const refresh = useCallback(async () => {
    await fetchDevices(showDeregistered);
    router.refresh();
  }, [fetchDevices, showDeregistered, router]);

  const activeDevices = devices.filter((d) => d.status !== 'deregistered');
  const onlineCount = activeDevices.filter((d) => isOnline(d.lastSeen)).length;
  const displayDevices = showDeregistered ? devices : activeDevices;

  return (
    <div
      className="flex flex-col rounded-lg border"
      style={{ background: '#111116', borderColor: 'rgba(255,255,255,0.06)' }}
    >
      {/* Header */}
      <div
        className="flex items-center gap-2 px-4 py-3 border-b flex-shrink-0"
        style={{ borderColor: 'rgba(255,255,255,0.05)' }}
      >
        <span
          className="font-mono text-[10px] uppercase tracking-[0.1em]"
          style={{ color: 'rgba(245,240,235,0.4)' }}
        >
          Agent daemons
        </span>

        {activeDevices.length > 0 && (
          <span
            className="font-mono text-[10px]"
            style={{ color: 'rgba(245,240,235,0.45)' }}
          >
            {onlineCount}/{activeDevices.length} online
          </span>
        )}

        {/* Show deregistered toggle */}
        <button
          onClick={() => { void toggleShowDeregistered(); }}
          className="ml-auto font-mono text-[10px] px-1.5 py-0.5 rounded transition-colors"
          style={{
            color: showDeregistered ? 'rgba(245,240,235,0.6)' : 'rgba(245,240,235,0.45)',
            background: showDeregistered ? 'rgba(255,255,255,0.06)' : 'transparent',
          }}
          disabled={loadingDevices}
          title={showDeregistered ? 'Hide deregistered' : 'Show deregistered'}
        >
          {showDeregistered ? 'hide old' : 'show old'}
        </button>
      </div>

      {/* Device list */}
      <div className="flex-1">
        {displayDevices.length === 0 ? (
          <p className="px-4 py-6 text-xs text-center" style={{ color: 'rgba(245,240,235,0.4)' }}>
            No devices registered.
          </p>
        ) : (
          <ul>
            {displayDevices.map((device, i) => (
              <DeviceRow
                key={device.id}
                device={device}
                isLast={i === displayDevices.length - 1}
                onMutate={refresh}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DeviceRow
// ---------------------------------------------------------------------------

interface DeviceRowProps {
  device: HubDevice;
  isLast: boolean;
  onMutate: () => Promise<void>;
}

function DeviceRow({ device, isLast, onMutate }: DeviceRowProps) {
  const online = isOnline(device.lastSeen);
  const deregistered = device.status === 'deregistered';

  const [renaming, setRenaming] = useState(false);
  const [nameInput, setNameInput] = useState(device.name);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renamePending, setRenamePending] = useState(false);

  const [showDeregisterConfirm, setShowDeregisterConfirm] = useState(false);
  const [deregisterPending, setDeregisterPending] = useState(false);
  const [deregisterError, setDeregisterError] = useState<string | null>(null);

  const [showRotateConfirm, setShowRotateConfirm] = useState(false);
  const [rotatePending, setRotatePending] = useState(false);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [rotateError, setRotateError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const nameInputRef = useRef<HTMLInputElement>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (renaming) nameInputRef.current?.focus();
  }, [renaming]);

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current !== null) clearTimeout(copiedTimerRef.current);
    };
  }, []);

  // -- rename --
  async function submitRename() {
    const trimmed = nameInput.trim();
    if (!trimmed || !/^[a-zA-Z0-9-]+$/.test(trimmed)) {
      setRenameError('Letters, numbers, hyphens only (1-64 chars)');
      return;
    }
    if (trimmed.length > 64) {
      setRenameError('Max 64 characters');
      return;
    }
    setRenamePending(true);
    setRenameError(null);
    const res = await fetch(`/api/hub/devices/${encodeURIComponent(device.id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: trimmed }),
    });
    setRenamePending(false);
    if (!res.ok) {
      setRenameError('Rename failed');
      return;
    }
    setRenaming(false);
    await onMutate();
  }

  function handleRenameKey(e: React.KeyboardEvent) {
    if (e.key === 'Enter') { void submitRename(); }
    if (e.key === 'Escape') {
      setRenaming(false);
      setNameInput(device.name);
      setRenameError(null);
    }
  }

  // -- deregister --
  async function confirmDeregister() {
    setDeregisterPending(true);
    setDeregisterError(null);
    const res = await fetch(`/api/hub/devices/${encodeURIComponent(device.id)}`, { method: 'DELETE' });
    setDeregisterPending(false);
    if (!res.ok) {
      setDeregisterError('Deregister failed');
      return;
    }
    setShowDeregisterConfirm(false);
    await onMutate();
  }

  // -- rotate token --
  async function confirmRotate() {
    setRotatePending(true);
    setRotateError(null);
    const res = await fetch(`/api/hub/devices/${encodeURIComponent(device.id)}/rotate-token`, { method: 'POST' });
    setRotatePending(false);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (body?.error === 'hub_error' && res.status === 410) {
        setRotateError('Device is deregistered');
      } else {
        setRotateError('Token rotation failed');
      }
      // Keep panel open so error message stays visible
      return;
    }
    const data = (await res.json()) as { token: string };
    setNewToken(data.token);
    setShowRotateConfirm(false);
  }

  async function dismissTokenModal() {
    setNewToken(null);
    setCopied(false);
    await onMutate();
  }

  async function copyToken() {
    if (!newToken) return;
    await navigator.clipboard.writeText(newToken);
    setCopied(true);
    if (copiedTimerRef.current !== null) clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => setCopied(false), 2000);
  }

  return (
    <li
      className="flex flex-col px-4 py-2.5"
      style={{
        borderBottom: isLast ? 'none' : '1px solid rgba(255,255,255,0.035)',
        opacity: deregistered ? 0.45 : 1,
      }}
    >
      <div className="flex items-center gap-3">
        {/* Online indicator */}
        <span className="relative flex h-2 w-2 flex-shrink-0">
          {online && !deregistered && (
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#2DD4A0] opacity-50" />
          )}
          <span
            className="relative inline-flex rounded-full h-2 w-2"
            style={{ background: (online && !deregistered) ? '#2DD4A0' : 'rgba(255,255,255,0.12)' }}
          />
        </span>

        {/* Name -- inline rename */}
        <div className="flex-1 min-w-0">
          {renaming ? (
            <div className="flex items-center gap-1">
              <input
                ref={nameInputRef}
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                onKeyDown={handleRenameKey}
                disabled={renamePending}
                className="text-xs font-medium bg-transparent border-b outline-none w-full"
                style={{
                  color: 'rgba(245,240,235,0.8)',
                  borderColor: 'rgba(255,255,255,0.2)',
                }}
                maxLength={64}
              />
              <button
                onClick={() => { void submitRename(); }}
                disabled={renamePending}
                className="flex items-center px-1 rounded"
                style={{ color: '#2DD4A0' }}
                title="Save"
                aria-label="Save name"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3" aria-hidden>
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              </button>
            </div>
          ) : (
            <div
              className="text-xs font-medium truncate cursor-pointer hover:underline"
              style={{ color: 'rgba(245,240,235,0.8)' }}
              onClick={() => {
                if (!deregistered) {
                  setRenaming(true);
                  setNameInput(device.name);
                  setRenameError(null);
                }
              }}
              title={deregistered ? undefined : 'Click to rename'}
            >
              {device.name}
            </div>
          )}
          {renameError && (
            <p className="text-[10px] mt-0.5" style={{ color: '#ff6b6b' }}>{renameError}</p>
          )}
          <div className="font-mono text-[10px] truncate" style={{ color: 'rgba(245,240,235,0.25)' }}>
            {device.hostname ?? device.id}
            {device.platform && <span className="ml-1.5">{platformLabel(device.platform)}</span>}
          </div>
        </div>

        {/* Status label */}
        {deregistered ? (
          <span
            className="font-mono text-[10px] flex-shrink-0 px-1 rounded"
            style={{ color: 'rgba(245,240,235,0.4)', background: 'rgba(255,255,255,0.06)' }}
          >
            deregistered
          </span>
        ) : (
          <span
            className="font-mono text-[10px] flex-shrink-0"
            style={{ color: online ? '#2DD4A0' : 'rgba(245,240,235,0.2)' }}
          >
            {online ? 'online' : 'offline'}
          </span>
        )}

        {/* Actions -- only for active devices */}
        {!deregistered && (
          <div className="flex items-center gap-1 flex-shrink-0">
            <button
              onClick={() => { setShowRotateConfirm(true); setRotateError(null); }}
              className="font-mono text-[10px] px-1.5 py-0.5 rounded transition-colors hover:bg-white/10"
              style={{ color: 'rgba(245,240,235,0.5)', background: 'rgba(255,255,255,0.04)' }}
              title="Rotate token"
            >
              rotate
            </button>
            <button
              onClick={() => { setShowDeregisterConfirm(true); setDeregisterError(null); }}
              className="font-mono text-[10px] px-1.5 py-0.5 rounded transition-colors"
              style={{ color: '#ff6b6b', background: 'rgba(255,107,107,0.08)' }}
              title="Deregister device"
            >
              dereg
            </button>
          </div>
        )}
      </div>

      {/* Deregister confirm */}
      {showDeregisterConfirm && (
        <div
          className="mt-2 rounded p-3 text-xs flex flex-col gap-2"
          style={{ background: 'rgba(255,107,107,0.06)', border: '1px solid rgba(255,107,107,0.15)' }}
        >
          <p style={{ color: 'rgba(245,240,235,0.7)' }}>
            Deregister <strong>{device.name}</strong>? The daemon on this machine will lose access
            immediately. This cannot be undone.
          </p>
          {deregisterError && <p style={{ color: '#ff6b6b' }}>{deregisterError}</p>}
          <div className="flex gap-2">
            <button
              onClick={() => { void confirmDeregister(); }}
              disabled={deregisterPending}
              className="text-[11px] px-2 py-1 rounded"
              style={{ background: 'rgba(255,107,107,0.18)', color: '#ff6b6b' }}
            >
              {deregisterPending ? 'Deregistering...' : 'Confirm Deregister'}
            </button>
            <button
              onClick={() => setShowDeregisterConfirm(false)}
              disabled={deregisterPending}
              className="text-[11px] px-2 py-1 rounded"
              style={{ color: 'rgba(245,240,235,0.3)' }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Rotate token confirm */}
      {showRotateConfirm && (
        <div
          className="mt-2 rounded p-3 text-xs flex flex-col gap-2"
          style={{ background: 'rgba(255,181,71,0.04)', border: '1px solid rgba(255,181,71,0.12)' }}
        >
          <p style={{ color: 'rgba(245,240,235,0.7)' }}>
            Generate a new token for <strong>{device.name}</strong>? The daemon will stop
            authenticating immediately. You must update its{' '}
            <code
              className="px-1 rounded"
              style={{ background: 'rgba(255,255,255,0.06)', fontFamily: 'monospace' }}
            >
              FORGE_DAEMON_DEVICE_TOKEN
            </code>{' '}
            before it can reconnect.
          </p>
          {rotateError && <p style={{ color: '#ff6b6b' }}>{rotateError}</p>}
          <div className="flex gap-2">
            <button
              onClick={() => { void confirmRotate(); }}
              disabled={rotatePending}
              className="text-[11px] px-2 py-1 rounded"
              style={{ background: 'rgba(255,181,71,0.14)', color: '#FFB547' }}
            >
              {rotatePending ? 'Rotating...' : 'Rotate Token'}
            </button>
            <button
              onClick={() => setShowRotateConfirm(false)}
              disabled={rotatePending}
              className="text-[11px] px-2 py-1 rounded"
              style={{ color: 'rgba(245,240,235,0.3)' }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* New token display */}
      {newToken && (
        <div
          className="mt-2 rounded p-3 text-xs flex flex-col gap-2"
          style={{ background: 'rgba(45,212,160,0.04)', border: '1px solid rgba(45,212,160,0.15)' }}
        >
          <p className="font-semibold" style={{ color: 'rgba(245,240,235,0.8)' }}>
            New token generated
          </p>
          <p style={{ color: 'rgba(245,240,235,0.5)' }}>
            This token will not be shown again. Copy it now and update your daemon config.
          </p>
          <div className="flex items-center gap-2">
            <input
              readOnly
              value={newToken}
              className="flex-1 font-mono text-[10px] bg-transparent border rounded px-2 py-1 outline-none"
              style={{
                borderColor: 'rgba(255,255,255,0.12)',
                color: 'rgba(245,240,235,0.8)',
                fontFamily: 'monospace',
              }}
            />
            <button
              onClick={() => { void copyToken(); }}
              className="text-[11px] px-2 py-1 rounded flex-shrink-0"
              style={{
                background: copied ? 'rgba(45,212,160,0.14)' : 'rgba(255,255,255,0.06)',
                color: copied ? '#2DD4A0' : 'rgba(245,240,235,0.5)',
              }}
            >
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
          <button
            onClick={() => { void dismissTokenModal(); }}
            className="self-start text-[11px] px-2 py-1 rounded"
            style={{ color: 'rgba(245,240,235,0.3)' }}
          >
            Dismiss
          </button>
        </div>
      )}
    </li>
  );
}
