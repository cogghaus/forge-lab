'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { HubSession } from '@/lib/hub';

/** Best-effort friendly label (browser + OS) from a raw User-Agent string. */
function describeUserAgent(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const browser =
    /Edg\//.test(ua) ? 'Edge'
    : /OPR\/|Opera/.test(ua) ? 'Opera'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Safari\//.test(ua) ? 'Safari'
    : /curl|wget|node|python/i.test(ua) ? 'API client'
    : 'Browser';
  const os =
    /Windows/.test(ua) ? 'Windows'
    : /iPhone|iPad|iOS/.test(ua) ? 'iOS'
    : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
    : /Android/.test(ua) ? 'Android'
    : /Linux/.test(ua) ? 'Linux'
    : '';
  return os ? `${browser} on ${os}` : browser;
}

function relative(iso: string | null): string {
  if (!iso) return 'unknown';
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return 'unknown';
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function SessionsPanel() {
  const router = useRouter();
  const [sessions, setSessions] = useState<HubSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [revokingOthers, setRevokingOthers] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/hub/auth/sessions');
      if (!res.ok) {
        setError('Could not load sessions.');
        return;
      }
      const data = (await res.json()) as { sessions: HubSession[] };
      setSessions(data.sessions ?? []);
      setError(null);
    } catch {
      setError('Could not load sessions.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function revoke(id: string) {
    setBusyId(id);
    try {
      const res = await fetch(`/api/hub/auth/sessions/${id}`, { method: 'DELETE' });
      if (res.ok) await load();
      else setError('Could not revoke that session.');
    } finally {
      setBusyId(null);
    }
  }

  async function revokeOthers() {
    setRevokingOthers(true);
    try {
      const res = await fetch('/api/hub/auth/sessions/revoke-others', { method: 'POST' });
      if (res.ok) {
        await load();
        router.refresh();
      } else {
        setError('Could not sign out other sessions.');
      }
    } finally {
      setRevokingOthers(false);
    }
  }

  const others = (sessions ?? []).filter((s) => !s.current).length;

  return (
    <div className="rounded-[10px] overflow-hidden" style={{ background: '#111116', border: '1px solid rgba(255,255,255,0.06)' }}>
      {error && (
        <div className="px-5 py-3" style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
          <span className="text-[12px]" style={{ color: 'rgba(255,80,80,0.75)' }}>{error}</span>
        </div>
      )}

      {sessions === null ? (
        <div className="px-5 py-8 text-center">
          <span className="font-mono text-[11px]" style={{ color: 'rgba(245,240,235,0.25)' }}>loading…</span>
        </div>
      ) : sessions.length === 0 ? (
        <div className="px-5 py-8 text-center">
          <span className="text-[13px]" style={{ color: 'rgba(245,240,235,0.3)' }}>No active sessions.</span>
        </div>
      ) : (
        <ul>
          {sessions.map((s, i) => (
            <li
              key={s.id}
              className="flex items-center gap-4 px-5 py-3.5"
              style={{ borderBottom: i === sessions.length - 1 ? 'none' : '1px solid rgba(255,255,255,0.04)' }}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium truncate" style={{ color: 'rgba(245,240,235,0.85)' }}>
                    {describeUserAgent(s.userAgent)}
                  </span>
                  {s.current && (
                    <span className="font-mono text-[10px] px-1.5 py-0.5 rounded flex-shrink-0" style={{ color: '#2DD4A0', background: 'rgba(45,212,160,0.12)' }}>
                      this device
                    </span>
                  )}
                </div>
                <div className="font-mono text-[11px] truncate mt-0.5" style={{ color: 'rgba(245,240,235,0.3)' }}>
                  {s.ipAddress ?? 'unknown ip'} &middot; active {relative(s.lastSeenAt ?? s.createdAt)}
                </div>
              </div>

              {s.current ? (
                <span className="font-mono text-[11px] flex-shrink-0" style={{ color: 'rgba(245,240,235,0.25)' }}>current</span>
              ) : (
                <button
                  type="button"
                  onClick={() => { void revoke(s.id); }}
                  disabled={busyId === s.id}
                  className="font-mono text-[11px] px-2.5 py-1 rounded flex-shrink-0 transition-colors disabled:opacity-40"
                  style={{ color: '#FF6B6B', background: 'rgba(255,107,107,0.08)' }}
                >
                  {busyId === s.id ? 'revoking…' : 'revoke'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {others > 0 && (
        <div className="px-5 py-3" style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
          <button
            type="button"
            onClick={() => { void revokeOthers(); }}
            disabled={revokingOthers}
            className="font-mono text-[11px] px-3 py-1.5 rounded transition-colors disabled:opacity-40"
            style={{ color: 'rgba(245,240,235,0.7)', background: 'rgba(255,255,255,0.06)' }}
          >
            {revokingOthers ? 'signing out…' : `Sign out all other sessions (${others})`}
          </button>
        </div>
      )}
    </div>
  );
}
