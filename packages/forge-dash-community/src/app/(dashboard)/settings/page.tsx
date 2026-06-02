import { redirect } from 'next/navigation';
import { hubFetch, type HubMe } from '@/lib/hub';
import { getSessionCookie, SESSION_COOKIE } from '@/lib/session';
import { PasswordChangeForm } from './password-change-form';
import { EmailChangeForm } from './email-change-form';
import { SessionsPanel } from './sessions-panel';

export default async function SettingsPage() {
  const session = await getSessionCookie();
  if (!session) redirect('/login');

  const cookieHeader = `${SESSION_COOKIE}=${session}`;
  const meRes = await hubFetch<HubMe>('/auth/me', { cookie: cookieHeader });
  const userEmail = meRes.ok ? meRes.data.email : null;

  return (
    <div className="max-w-2xl">
      {/* Page header */}
      <div className="flex items-center gap-3 mb-8">
        <h1 className="font-mono text-[18px] font-bold">Settings</h1>
      </div>

      {/* Account section */}
      <section className="mb-8">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-mono text-[13px] font-semibold" style={{ color: 'rgba(245,240,235,0.6)' }}>
            Account
          </h2>
        </div>

        <div
          className="rounded-[10px] overflow-hidden"
          style={{ background: '#111116', border: '1px solid rgba(255,255,255,0.06)' }}
        >
          <div className="px-5 py-5" style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            {/* Email */}
            {userEmail && (
              <div>
                <p className="font-mono text-[11px]" style={{ color: 'rgba(245,240,235,0.4)', marginBottom: '4px' }}>
                  Email
                </p>
                <p className="font-mono text-[13px]" style={{ color: 'rgba(245,240,235,0.55)' }}>
                  {userEmail}
                </p>
              </div>
            )}

            {/* Email change */}
            <div>
              <p className="font-mono text-[11px]" style={{ color: 'rgba(245,240,235,0.4)', marginBottom: '12px' }}>
                Change email
              </p>
              <EmailChangeForm />
            </div>

            <div style={{ height: '1px', background: 'rgba(255,255,255,0.06)', margin: '16px 0' }} />

            {/* Password change */}
            <div>
              <p className="font-mono text-[11px]" style={{ color: 'rgba(245,240,235,0.4)', marginBottom: '12px' }}>
                Change password
              </p>
              <PasswordChangeForm />
            </div>
          </div>
        </div>
      </section>

      {/* Active sessions (this user's authorized logins) */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-mono text-[13px] font-semibold" style={{ color: 'rgba(245,240,235,0.6)' }}>
            Active sessions
          </h2>
        </div>
        <p className="font-mono text-[11px] mb-3" style={{ color: 'rgba(245,240,235,0.3)' }}>
          Browsers and apps signed in to your account. Revoke any you don&apos;t recognise.
        </p>
        <SessionsPanel />
      </section>
    </div>
  );
}
