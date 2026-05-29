import { redirect } from 'next/navigation';
import { hubFetch, type HubDevice, type HubMe } from '@/lib/hub';
import { getSessionCookie, SESSION_COOKIE } from '@/lib/session';
import { PasswordChangeForm } from './password-change-form';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ONLINE_THRESHOLD_MS = 5 * 60 * 1000;

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
// Sub-components
// ---------------------------------------------------------------------------

function DeviceTypeBadge({ type }: { type: 'worker' | 'orchestrator' }) {
  const isOrch = type === 'orchestrator';
  return (
    <span
      className="font-mono text-[10px] px-1.5 py-0.5 rounded flex-shrink-0"
      style={{
        color: isOrch ? '#A78BFA' : 'rgba(245,240,235,0.4)',
        background: isOrch ? 'rgba(167,139,250,0.12)' : 'rgba(255,255,255,0.06)',
      }}
    >
      {isOrch ? 'orch' : 'worker'}
    </span>
  );
}

function DeviceRow({ device, isLast }: { device: HubDevice; isLast: boolean }) {
  const online = isOnline(device.lastSeen);
  return (
    <li
      className="flex items-center gap-4 px-5 py-3.5"
      style={{
        borderBottom: isLast ? 'none' : '1px solid rgba(255,255,255,0.04)',
      }}
    >
      {/* Online dot */}
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
          className="text-sm font-medium truncate"
          style={{ color: 'rgba(245,240,235,0.85)' }}
        >
          {device.name}
        </div>
        <div
          className="font-mono text-[11px] truncate mt-0.5"
          style={{ color: 'rgba(245,240,235,0.28)' }}
        >
          {device.hostname ?? device.id}
          {device.platform && <span className="ml-1.5">{platformLabel(device.platform)}</span>}
          {device.agentId && (
            <span className="ml-2" style={{ color: 'rgba(245,240,235,0.45)' }}>
              agent:{device.agentId}
            </span>
          )}
        </div>
      </div>

      {/* Type badge */}
      <DeviceTypeBadge type={device.deviceType} />

      {/* Status */}
      <span
        className="font-mono text-[11px] flex-shrink-0 w-[46px] text-right"
        style={{ color: online ? '#2DD4A0' : 'rgba(245,240,235,0.2)' }}
      >
        {online ? 'online' : 'offline'}
      </span>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function SettingsPage() {
  const session = await getSessionCookie();
  if (!session) redirect('/login');

  const cookieHeader = `${SESSION_COOKIE}=${session}`;

  const [devicesRes, meRes] = await Promise.all([
    hubFetch<{ devices: HubDevice[] }>('/devices', { cookie: cookieHeader }),
    hubFetch<HubMe>('/auth/me', { cookie: cookieHeader }),
  ]);

  const devicesFetchFailed = !devicesRes.ok;
  const devices = devicesRes.ok ? devicesRes.data.devices : [];
  const userEmail = meRes.ok ? meRes.data.email : null;

  const onlineCount = devices.filter((d) => isOnline(d.lastSeen)).length;
  const orchCount = devices.filter((d) => d.deviceType === 'orchestrator').length;
  const workerCount = devices.filter((d) => d.deviceType === 'worker').length;

  return (
    <div className="max-w-2xl">
      {/* Page header */}
      <div className="flex items-center gap-3 mb-8">
        <h1 className="font-mono text-[18px] font-bold">Settings</h1>
      </div>

      {/* Account section */}
      <section className="mb-8">
        <div className="flex items-center justify-between mb-3">
          <h2
            className="font-mono text-[13px] font-semibold"
            style={{ color: 'rgba(245,240,235,0.6)' }}
          >
            Account
          </h2>
        </div>

        <div
          className="rounded-[10px] overflow-hidden"
          style={{
            background: '#111116',
            border: '1px solid rgba(255,255,255,0.06)',
          }}
        >
          <div className="px-5 py-5" style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            {/* Email */}
            {userEmail && (
              <div>
                <p
                  className="font-mono text-[11px]"
                  style={{ color: 'rgba(245,240,235,0.4)', marginBottom: '4px' }}
                >
                  Email
                </p>
                <p
                  className="font-mono text-[13px]"
                  style={{ color: 'rgba(245,240,235,0.55)' }}
                >
                  {userEmail}
                </p>
              </div>
            )}

            {/* Password change */}
            <div>
              <p
                className="font-mono text-[11px]"
                style={{ color: 'rgba(245,240,235,0.4)', marginBottom: '12px' }}
              >
                Change password
              </p>
              <PasswordChangeForm />
            </div>
          </div>
        </div>
      </section>

      {/* Devices section */}
      <section className="mb-8">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            <h2
              className="font-mono text-[13px] font-semibold"
              style={{ color: 'rgba(245,240,235,0.6)' }}
            >
              Devices
            </h2>
            {devices.length > 0 && (
              <span
                className="font-mono text-[10px]"
                style={{ color: 'rgba(245,240,235,0.25)' }}
              >
                {onlineCount}/{devices.length} online &middot; {orchCount} orch &middot; {workerCount} worker
              </span>
            )}
          </div>
        </div>

        <div
          className="rounded-[10px] overflow-hidden"
          style={{
            background: '#111116',
            border: '1px solid rgba(255,255,255,0.06)',
          }}
        >
          {devicesFetchFailed ? (
            <div className="px-5 py-10 text-center">
              <p
                className="text-[13px]"
                style={{ color: 'rgba(255,80,80,0.7)' }}
              >
                Could not load devices. Hub may be unreachable.
              </p>
            </div>
          ) : devices.length === 0 ? (
            <div className="px-5 py-10 text-center">
              <p
                className="text-[13px] mb-2"
                style={{ color: 'rgba(245,240,235,0.3)' }}
              >
                No devices registered yet.
              </p>
              <p
                className="font-mono text-[11px]"
                style={{ color: 'rgba(245,240,235,0.18)' }}
              >
                Register a device via the CLI to connect an agent.
              </p>
            </div>
          ) : (
            <ul>
              {devices.map((device, i) => (
                <DeviceRow
                  key={device.id}
                  device={device}
                  isLast={i === devices.length - 1}
                />
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* Register hint */}
      <section>
        <div
          className="rounded-[10px] px-5 py-4"
          style={{
            background: 'rgba(255,255,255,0.025)',
            border: '1px solid rgba(255,255,255,0.05)',
          }}
        >
          <p
            className="font-mono text-[11px] mb-1.5"
            style={{ color: 'rgba(245,240,235,0.4)' }}
          >
            Register a device
          </p>
          <p
            className="font-mono text-[11px]"
            style={{ color: 'rgba(245,240,235,0.22)' }}
          >
            Use{' '}
            <code
              className="px-1 rounded"
              style={{ background: 'rgba(255,255,255,0.06)' }}
            >
              forge-daemon register
            </code>{' '}
            from your agent host to create a new device token and link it to your account.
          </p>
        </div>
      </section>
    </div>
  );
}
