'use client';

import { useState } from 'react';
import type { HubPersonality } from '@/lib/hub';

type State =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'loaded'; p: HubPersonality }
  | { kind: 'none' }
  | { kind: 'error' };

export function AgentPersonalityButton({ agentId }: { agentId: string }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<State>({ kind: 'idle' });

  async function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (state.kind === 'loaded' || state.kind === 'none') return; // cached
    setState({ kind: 'loading' });
    try {
      const res = await fetch(`/api/hub/agents/${encodeURIComponent(agentId)}/personality`);
      if (res.status === 404) {
        setState({ kind: 'none' });
        return;
      }
      if (!res.ok) {
        setState({ kind: 'error' });
        return;
      }
      setState({ kind: 'loaded', p: (await res.json()) as HubPersonality });
    } catch {
      setState({ kind: 'error' });
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => { void toggle(); }}
        aria-expanded={open}
        className="self-start rounded-md border px-3 py-1.5 font-mono text-[11px] transition-colors"
        style={{ borderColor: 'rgba(255,255,255,0.12)', color: 'rgba(245,240,235,0.75)', background: 'rgba(255,255,255,0.04)' }}
      >
        {open ? 'Hide personality' : 'View personality'}
      </button>

      {open && (
        <div
          className="rounded-md p-3"
          style={{ background: 'rgba(0,0,0,0.35)', border: '1px solid rgba(255,255,255,0.06)' }}
        >
          {state.kind === 'loading' && (
            <span className="font-mono text-[10px]" style={{ color: 'rgba(245,240,235,0.4)' }}>loading…</span>
          )}
          {state.kind === 'none' && (
            <span className="font-mono text-[11px]" style={{ color: 'rgba(245,240,235,0.4)' }}>
              No personality defined yet for this agent.
            </span>
          )}
          {state.kind === 'error' && (
            <span className="font-mono text-[11px]" style={{ color: '#FF6B6B' }}>
              Could not load personality.
            </span>
          )}
          {state.kind === 'loaded' && (
            <div className="flex flex-col gap-1.5">
              <div className="text-[13px] font-semibold" style={{ color: 'rgba(245,240,235,0.9)' }}>
                {state.p.name}
              </div>
              {state.p.description && (
                <div className="text-[11px]" style={{ color: 'rgba(245,240,235,0.5)' }}>{state.p.description}</div>
              )}
              <pre
                className="mt-1 max-h-72 overflow-y-auto whitespace-pre-wrap font-mono text-[10px] leading-relaxed"
                style={{ color: 'rgba(245,240,235,0.6)' }}
              >
                {state.p.systemPrompt}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
