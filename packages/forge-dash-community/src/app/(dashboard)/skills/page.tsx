import { redirect } from 'next/navigation';
import { hubFetch, type HubRuntimeConfig } from '@/lib/hub';
import { getSessionCookie, SESSION_COOKIE } from '@/lib/session';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return 'unknown date';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function RuntimeIdBadge({ runtimeId }: { runtimeId: string }) {
  // Colour-code well-known runtimes
  const color =
    runtimeId === 'claude-code'
      ? { text: '#60A5FA', bg: 'rgba(96,165,250,0.10)' }
      : runtimeId === 'forge-daemon'
        ? { text: '#F59E0B', bg: 'rgba(245,158,11,0.10)' }
        : { text: 'rgba(245,240,235,0.4)', bg: 'rgba(255,255,255,0.06)' };

  return (
    <span
      className="font-mono text-[10px] px-1.5 py-0.5 rounded flex-shrink-0"
      style={{ color: color.text, background: color.bg }}
    >
      {runtimeId}
    </span>
  );
}

function ConfigCard({ config }: { config: HubRuntimeConfig }) {
  const keyCount = Object.keys(config.config).length;

  return (
    <div
      className="rounded-[10px] overflow-hidden"
      style={{
        background: '#111116',
        border: '1px solid rgba(255,255,255,0.06)',
      }}
    >
      {/* Card header */}
      <div
        className="flex items-center gap-3 px-5 py-3.5"
        style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}
      >
        <div className="flex-1 min-w-0">
          <div
            className="text-sm font-medium truncate"
            style={{ color: 'rgba(245,240,235,0.85)' }}
          >
            {config.name}
          </div>
          <div
            className="font-mono text-[10px] mt-0.5"
            style={{ color: 'rgba(245,240,235,0.25)' }}
          >
            {formatDate(config.createdAt)}
            {keyCount > 0 && (
              <span className="ml-2">{keyCount} {keyCount === 1 ? 'key' : 'keys'}</span>
            )}
          </div>
        </div>
        <RuntimeIdBadge runtimeId={config.runtimeId} />
      </div>

      {/* Config JSON — only render if non-empty */}
      {keyCount > 0 && (
        <pre
          className="px-5 py-4 font-mono text-[11px] overflow-x-auto"
          style={{ color: 'rgba(245,240,235,0.45)', margin: 0 }}
        >
          {JSON.stringify(config.config, null, 2)}
        </pre>
      )}

      {keyCount === 0 && (
        <div
          className="px-5 py-3"
        >
          <span
            className="font-mono text-[11px]"
            style={{ color: 'rgba(245,240,235,0.18)' }}
          >
            No config keys set.
          </span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function SkillsPage() {
  const session = await getSessionCookie();
  if (!session) redirect('/login');

  const cookieHeader = `${SESSION_COOKIE}=${session}`;
  const configsRes = await hubFetch<{ configs: HubRuntimeConfig[] }>('/runtime-configs', {
    cookie: cookieHeader,
  });
  const fetchFailed = !configsRes.ok;
  const configs = configsRes.ok ? configsRes.data.configs : [];

  return (
    <div className="max-w-2xl">
      {/* Page header */}
      <div className="flex items-center gap-3 mb-8">
        <h1 className="font-mono text-[18px] font-bold">Skills</h1>
        {configs.length > 0 && (
          <span
            className="font-mono text-[10px] px-2 py-0.5 rounded"
            style={{ background: 'rgba(255,255,255,0.06)', color: 'rgba(245,240,235,0.4)' }}
          >
            {configs.length}
          </span>
        )}
      </div>

      {/* Runtime configs list */}
      {fetchFailed ? (
        <div
          className="rounded-[10px] px-5 py-10 text-center"
          style={{
            background: '#111116',
            border: '1px solid rgba(255,255,255,0.06)',
          }}
        >
          <p
            className="text-[13px]"
            style={{ color: 'rgba(255,80,80,0.7)' }}
          >
            Could not load runtime configs. Hub may be unreachable.
          </p>
        </div>
      ) : configs.length === 0 ? (
        <div
          className="rounded-[10px] px-5 py-10 text-center"
          style={{
            background: '#111116',
            border: '1px solid rgba(255,255,255,0.06)',
          }}
        >
          <p
            className="text-[13px] mb-2"
            style={{ color: 'rgba(245,240,235,0.3)' }}
          >
            No runtime configs yet.
          </p>
          <p
            className="font-mono text-[11px]"
            style={{ color: 'rgba(245,240,235,0.18)' }}
          >
            Create a config via the API to define agent personality and skill parameters.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {configs.map((config) => (
            <ConfigCard key={config.id} config={config} />
          ))}
        </div>
      )}
    </div>
  );
}
