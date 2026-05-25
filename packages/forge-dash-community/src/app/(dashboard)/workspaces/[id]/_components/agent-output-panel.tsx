'use client';

import { useEffect, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentOutputPanelProps {
  /** Task whose log to stream. Null means no panel is open. */
  taskId: string | null;
  /** Display title shown in the panel header. */
  taskTitle: string | null;
  /** Whether the panel is visible. */
  isOpen: boolean;
  /** Called when the user presses the close button. */
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// AgentOutputPanel
// ---------------------------------------------------------------------------

/**
 * 380 px fixed right rail that streams agent output via SSE.
 *
 * Connects to `GET /api/agents/${taskId}/stream` whenever `isOpen` and
 * `taskId` are both truthy. Displays a pulsing orange live indicator while
 * the connection is open, and turns it off on `event: done` or connection
 * error. Automatically scrolls to the bottom as new lines arrive.
 *
 * Cleans up the EventSource on close, taskId change, or component unmount.
 */
export function AgentOutputPanel({
  taskId,
  taskTitle,
  isOpen,
  onClose,
}: AgentOutputPanelProps) {
  const [lines, setLines] = useState<string[]>([]);
  const [isLive, setIsLive] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  // ------------------------------------------------------------------
  // SSE connection
  // ------------------------------------------------------------------
  useEffect(() => {
    if (!isOpen || !taskId) return;

    setLines([]);
    setIsLive(true);

    const es = new EventSource(`/api/agents/${taskId}/stream`);

    es.onmessage = (e: MessageEvent<string>) => {
      setLines((prev) => [...prev, e.data]);
    };

    es.addEventListener('done', () => {
      setIsLive(false);
      es.close();
    });

    es.onerror = () => {
      setIsLive(false);
      es.close();
    };

    return () => {
      es.close();
      setIsLive(false);
    };
  }, [isOpen, taskId]);

  // ------------------------------------------------------------------
  // Auto-scroll to bottom on new lines
  // ------------------------------------------------------------------
  useEffect(() => {
    if (lines.length > 0) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [lines.length]);

  if (!isOpen) return null;

  return (
    <div
      className="flex flex-col border-l flex-shrink-0"
      style={{
        width: 380,
        background: '#111116',
        borderColor: 'rgba(255,255,255,0.06)',
        minHeight: 320,
        maxHeight: 'calc(100vh - 120px)',
        position: 'sticky',
        top: '72px',
        alignSelf: 'flex-start',
      }}
    >
      {/* Header */}
      <div
        className="flex items-start justify-between px-4 py-3 border-b flex-shrink-0"
        style={{ borderColor: 'rgba(255,255,255,0.05)' }}
      >
        <div className="flex flex-col gap-0.5 min-w-0 flex-1 pr-2">
          <span
            className="font-mono text-[10px] uppercase tracking-[0.1em]"
            style={{ color: 'rgba(245,240,235,0.4)' }}
          >
            Agent output
          </span>
          {taskTitle && (
            <span
              className="text-sm font-medium truncate"
              style={{ color: 'rgba(245,240,235,0.85)' }}
            >
              {taskTitle}
            </span>
          )}
          {taskId && (
            <span
              className="font-mono text-[10px]"
              style={{ color: 'rgba(245,240,235,0.3)' }}
            >
              {taskId}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-lg leading-none w-6 h-6 flex items-center justify-center flex-shrink-0 rounded transition-colors hover:bg-white/[0.06]"
          style={{ color: 'rgba(255,255,255,0.35)' }}
          aria-label="Close panel"
        >
          ×
        </button>
      </div>

      {/* Live indicator */}
      {isLive && (
        <div
          className="flex items-center gap-1.5 px-4 py-1.5 border-b flex-shrink-0"
          style={{
            borderColor: 'rgba(255,255,255,0.04)',
            color: 'rgba(245,240,235,0.4)',
          }}
        >
          <span className="relative flex h-1.5 w-1.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#FF6B2B] opacity-60" />
            <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-[#FF6B2B]" />
          </span>
          <span className="font-mono text-[10px] uppercase tracking-wider">live</span>
        </div>
      )}

      {/* Log output area */}
      <div
        className="flex-1 overflow-y-auto p-3"
        style={{
          background: 'rgba(0,0,0,0.35)',
          fontFamily: "'JetBrains Mono', 'Fira Code', 'Courier New', monospace",
          fontSize: '10px',
          lineHeight: '1.7',
          color: 'rgba(245,240,235,0.5)',
        }}
      >
        {lines.length === 0 ? (
          <span style={{ color: 'rgba(245,240,235,0.2)' }}>
            {isLive ? 'Waiting for output…' : 'No output available.'}
          </span>
        ) : (
          <>
            {lines.map((line, i) => (
              // Index key is safe: lines are append-only and never reordered.
              <div key={i}>{line}</div>
            ))}
            <div ref={bottomRef} />
          </>
        )}
      </div>
    </div>
  );
}
