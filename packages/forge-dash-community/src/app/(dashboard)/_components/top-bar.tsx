'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';
import type { HubWorkspace } from '@/lib/hub';

const TEMP_CYCLE = ['cold', 'warm', 'hot'] as const;
type Temp = (typeof TEMP_CYCLE)[number];

const TEMP_STYLE: Record<Temp, { bg: string; border: string; color: string }> = {
  cold: { bg: 'rgba(74,158,255,0.1)',  border: 'rgba(74,158,255,0.3)',  color: '#4A9EFF' },
  warm: { bg: 'rgba(255,107,43,0.12)', border: 'rgba(255,107,43,0.35)', color: '#FF6B2B' },
  hot:  { bg: 'rgba(255,181,71,0.15)', border: 'rgba(255,181,71,0.45)', color: '#FFB547' },
};

export function TopBar({ workspaces }: { workspaces: HubWorkspace[] }) {
  const pathname = usePathname();
  const router = useRouter();
  const [temp, setTemp] = useState<Temp>('warm');
  const [dropdownOpen, setDropdownOpen] = useState(false);

  const wsMatch = pathname.match(/^\/workspaces\/([^/]+)/);
  const activeWsId = wsMatch?.[1] ?? null;
  const activeWs = workspaces.find(ws => ws.id === activeWsId);
  const ts = TEMP_STYLE[temp];

  function cycleTemp() {
    const idx = TEMP_CYCLE.indexOf(temp);
    const next = TEMP_CYCLE[(idx + 1) % TEMP_CYCLE.length];
    if (next) setTemp(next);
  }

  function closeDropdown() {
    setDropdownOpen(false);
  }

  return (
    <header
      className="flex-shrink-0 flex items-center z-30 relative"
      style={{
        height: 52,
        background: 'rgba(13,13,15,0.92)',
        borderBottom: '1px solid rgba(255,255,255,0.05)',
        backdropFilter: 'blur(12px)',
      }}
    >
      {/* Logo zone — width matches left rail */}
      <div
        className="flex items-center gap-2 px-3 flex-shrink-0"
        style={{ width: 220, borderRight: '1px solid rgba(255,255,255,0.04)', height: '100%' }}
      >
        <Link href="/workspaces" className="flex items-center gap-2 hover:opacity-80 transition-opacity">
          <span className="text-[19px] leading-none select-none">🔥</span>
          <span className="font-mono text-[14px] font-bold tracking-[-0.02em] text-[#F5F0EB]">forge-lab</span>
        </Link>
      </div>

      {/* Main zone — aligned with main content panel */}
      <div className="flex-1 flex items-center justify-between px-5">
        {/* Workspace selector */}
        <div className="relative">
          <button
            onClick={() => setDropdownOpen(o => !o)}
            className="flex items-center gap-1.5 px-2 py-1 rounded-md transition-colors hover:bg-white/[0.05] font-mono text-[12px]"
            style={{ color: 'rgba(245,240,235,0.55)' }}
            aria-haspopup="listbox"
            aria-expanded={dropdownOpen}
            aria-label={activeWs?.name ?? 'Select workspace'}
          >
            <span>{activeWs?.name ?? 'Select workspace'}</span>
            <span className="text-[10px] text-white/25">▾</span>
          </button>

          {dropdownOpen && (
            <>
              <div
                className="fixed inset-0 z-40"
                onClick={closeDropdown}
                onKeyDown={e => { if (e.key === 'Escape') closeDropdown(); }}
              />
              <div
                className="absolute top-full left-0 z-50 rounded-[10px] p-2"
                role="listbox"
                aria-label="Workspaces"
                onKeyDown={e => { if (e.key === 'Escape') closeDropdown(); }}
                style={{
                  width: 280,
                  background: '#24242C',
                  border: '1px solid rgba(255,255,255,0.12)',
                  boxShadow: '0 16px 40px rgba(0,0,0,0.5)',
                  marginTop: 4,
                }}
              >
                <div
                  className="font-mono text-[9px] tracking-[0.12em] uppercase px-2 pb-2 pt-1"
                  style={{ color: 'rgba(245,240,235,0.3)' }}
                >
                  Workspaces
                </div>
                {workspaces.map(ws => (
                  <button
                    key={ws.id}
                    role="option"
                    aria-selected={ws.id === activeWsId}
                    onClick={() => { router.push(`/workspaces/${ws.id}`); closeDropdown(); }}
                    className={`w-full flex items-center justify-between px-2.5 py-2 rounded-md transition-colors text-[13px] ${
                      ws.id === activeWsId
                        ? 'bg-[rgba(255,107,43,0.08)]'
                        : 'hover:bg-[rgba(255,255,255,0.04)]'
                    }`}
                  >
                    <span style={{ color: ws.id === activeWsId ? '#F5F0EB' : 'rgba(245,240,235,0.6)' }}>
                      {ws.name}
                    </span>
                    <span
                      className="font-mono text-[10px] uppercase tracking-[0.08em] px-2 py-0.5 rounded"
                      style={{
                        background: ws.id === activeWsId ? 'rgba(255,107,43,0.15)' : 'rgba(255,255,255,0.06)',
                        color: ws.id === activeWsId ? '#FF6B2B' : 'rgba(245,240,235,0.5)',
                      }}
                    >
                      {ws.role}
                    </span>
                  </button>
                ))}
                <div className="border-t my-1.5" style={{ borderColor: 'rgba(255,255,255,0.06)' }} />
                <button
                  aria-disabled="true"
                  className="w-full flex items-center gap-2 px-2.5 py-2 rounded-md text-[13px] transition-colors text-[rgba(245,240,235,0.35)] hover:bg-[rgba(255,255,255,0.04)] hover:text-[rgba(245,240,235,0.6)]"
                >
                  <span>+</span> New workspace
                </button>
              </div>
            </>
          )}
        </div>

        {/* Temperature pill */}
        <button
          onClick={cycleTemp}
          className="font-mono text-[11px] tracking-[0.1em] uppercase px-2.5 py-1 rounded-full transition-all"
          style={{ background: ts.bg, border: `1px solid ${ts.border}`, color: ts.color }}
          aria-label={`System temperature: ${temp}. Click to cycle.`}
        >
          🌡 {temp}
        </button>
      </div>
    </header>
  );
}
