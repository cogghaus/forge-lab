import type { HubActivityEvent } from '@/lib/hub';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Maps event names to a short human label + accent colour. */
const EVENT_META: Record<string, { label: string; color: string }> = {
  'task.created':   { label: 'created',   color: '#4A9EFF' },
  'task.claimed':   { label: 'claimed',   color: '#FF6B2B' },
  'task.completed': { label: 'completed', color: '#2DD4A0' },
  'task.failed':    { label: 'failed',    color: '#FF4757' },
  'task.cancelled': { label: 'cancelled', color: '#FF4757' },
  'task.requeued':  { label: 'requeued',  color: '#FFB547' },
};

function eventMeta(name: string): { label: string; color: string } {
  return EVENT_META[name] ?? { label: name, color: 'rgba(245,240,235,0.35)' };
}

/** Formats a millisecond epoch timestamp as relative time (e.g. "3m ago"). */
function relativeTime(ms: number): string {
  const diffS = Math.floor((Date.now() - ms) / 1000);
  if (diffS < 60)  return `${diffS}s ago`;
  if (diffS < 3600) return `${Math.floor(diffS / 60)}m ago`;
  if (diffS < 86400) return `${Math.floor(diffS / 3600)}h ago`;
  return `${Math.floor(diffS / 86400)}d ago`;
}

/** Strips the "user:" / "device:" prefix from a source string. */
function shortSource(source: string): string {
  return source.replace(/^(user|device):/, '');
}

// ---------------------------------------------------------------------------
// ActivityStreamPanel
// ---------------------------------------------------------------------------

export interface ActivityStreamPanelProps {
  activity: HubActivityEvent[];
  /** Show pulsing live indicator when tasks are in_progress. */
  isLive?: boolean;
}

export function ActivityStreamPanel({ activity, isLive = false }: ActivityStreamPanelProps) {
  return (
    <div
      className="flex flex-col rounded-lg border flex-1 min-w-0"
      style={{
        background: '#111116',
        borderColor: 'rgba(255,255,255,0.06)',
      }}
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
          Activity
        </span>

        {/* Live indicator — shown when tasks are in_progress */}
        {isLive && (
          <span className="flex items-center gap-1" style={{ color: '#FF6B2B' }}>
            <span className="relative flex h-1.5 w-1.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#FF6B2B] opacity-60" />
              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-[#FF6B2B]" />
            </span>
            <span className="font-mono text-[10px] uppercase tracking-[0.1em]">live</span>
          </span>
        )}

        {activity.length > 0 && (
          <span
            className="font-mono text-[10px] ml-auto"
            style={{ color: 'rgba(245,240,235,0.2)' }}
          >
            {activity.length} event{activity.length !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {/* Event list */}
      <div className="flex-1 overflow-y-auto">
        {activity.length === 0 ? (
          <p
            className="px-4 py-6 text-xs text-center"
            style={{ color: 'rgba(245,240,235,0.2)' }}
          >
            No activity yet. Create a task to get started.
          </p>
        ) : (
          <ul>
            {activity.map((event, i) => {
              const meta = eventMeta(event.eventName);
              const isLast = i === activity.length - 1;
              return (
                <li
                  key={event.id}
                  className="flex items-start gap-3 px-4 py-2.5"
                  style={{
                    borderBottom: isLast ? 'none' : '1px solid rgba(255,255,255,0.035)',
                  }}
                >
                  {/* Colour dot */}
                  <span
                    className="mt-1 flex-shrink-0 w-1.5 h-1.5 rounded-full"
                    style={{ background: meta.color }}
                  />

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    {/* Task title + badge */}
                    <div className="flex items-center gap-2 flex-wrap">
                      <span
                        className="text-xs font-medium truncate"
                        style={{ color: 'rgba(245,240,235,0.8)' }}
                      >
                        {event.taskTitle}
                      </span>
                      <span
                        className="font-mono text-[10px] px-1 rounded"
                        style={{
                          color: meta.color,
                          background: `${meta.color}18`,
                        }}
                      >
                        {meta.label}
                      </span>
                    </div>

                    {/* Source + time */}
                    <div
                      className="flex items-center gap-2 mt-0.5"
                      style={{ color: 'rgba(245,240,235,0.25)' }}
                    >
                      <span className="font-mono text-[10px] truncate">
                        {event.taskId}
                      </span>
                      <span className="text-[10px]">·</span>
                      <span className="font-mono text-[10px] truncate">
                        {shortSource(event.source)}
                      </span>
                      <span className="text-[10px] ml-auto flex-shrink-0">
                        {relativeTime(event.createdAt)}
                      </span>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
