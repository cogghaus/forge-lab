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
  return Date.now() - new Date(lastSeen).getTime() < ONLINE_THRESHOLD_MS;
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
// DevicesPanel
// ---------------------------------------------------------------------------

export interface DevicesPanelProps {
  devices: HubDevice[];
  /** Count of pending_agent tasks — shown as queue depth in the header. */
  queueDepth?: number;
}

export function DevicesPanel({ devices, queueDepth = 0 }: DevicesPanelProps) {
  const onlineCount = devices.filter((d) => isOnline(d.lastSeen)).length;

  return (
    <div
      className="flex flex-col rounded-lg border"
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
          Devices
        </span>

        {/* Queue depth badge — pending_agent tasks waiting for a device */}
        {queueDepth > 0 && (
          <span
            className="font-mono text-[10px] px-1 rounded"
            style={{
              color: '#FFB547',
              background: 'rgba(255,181,71,0.12)',
            }}
          >
            {queueDepth} queued
          </span>
        )}

        {devices.length > 0 && (
          <span
            className="font-mono text-[10px] ml-auto"
            style={{ color: 'rgba(245,240,235,0.2)' }}
          >
            {onlineCount}/{devices.length} online
          </span>
        )}
      </div>

      {/* Device list */}
      <div className="flex-1">
        {devices.length === 0 ? (
          <p
            className="px-4 py-6 text-xs text-center"
            style={{ color: 'rgba(245,240,235,0.2)' }}
          >
            No devices registered.
          </p>
        ) : (
          <ul>
            {devices.map((device, i) => {
              const online = isOnline(device.lastSeen);
              const isLast = i === devices.length - 1;
              return (
                <li
                  key={device.id}
                  className="flex items-center gap-3 px-4 py-2.5"
                  style={{
                    borderBottom: isLast ? 'none' : '1px solid rgba(255,255,255,0.035)',
                  }}
                >
                  {/* Online indicator */}
                  <span className="relative flex h-2 w-2 flex-shrink-0">
                    {online && (
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#2DD4A0] opacity-50" />
                    )}
                    <span
                      className="relative inline-flex rounded-full h-2 w-2"
                      style={{ background: online ? '#2DD4A0' : 'rgba(255,255,255,0.12)' }}
                    />
                  </span>

                  {/* Name + meta */}
                  <div className="flex-1 min-w-0">
                    <div
                      className="text-xs font-medium truncate"
                      style={{ color: 'rgba(245,240,235,0.8)' }}
                    >
                      {device.name}
                    </div>
                    <div
                      className="font-mono text-[10px] truncate"
                      style={{ color: 'rgba(245,240,235,0.25)' }}
                    >
                      {device.hostname ?? device.id}
                      {device.platform && (
                        <span className="ml-1.5">{platformLabel(device.platform)}</span>
                      )}
                    </div>
                  </div>

                  {/* Status label */}
                  <span
                    className="font-mono text-[10px] flex-shrink-0"
                    style={{ color: online ? '#2DD4A0' : 'rgba(245,240,235,0.2)' }}
                  >
                    {online ? 'online' : 'offline'}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
