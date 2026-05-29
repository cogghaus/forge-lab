import Link from 'next/link';
import { hubFetch } from '@/lib/hub';

interface Props {
  searchParams: Promise<{ token?: string }>;
}

export default async function VerifyEmailPage({ searchParams }: Props) {
  const { token } = await searchParams;

  const ERROR_MESSAGES: Record<string, string> = {
    token_required: 'No verification token provided.',
    invalid_token: 'This verification link is invalid or has already been used.',
    token_expired: 'This verification link has expired. Please request a new email change.',
    email_taken: 'That email address is no longer available.',
  };

  let success = false;
  let errorMsg = 'Something went wrong. Please try again.';

  if (token) {
    const res = await hubFetch<{ ok: boolean; error?: string }>(`/auth/email/verify?token=${encodeURIComponent(token)}`);
    if (res.ok && res.data.ok) {
      success = true;
    } else {
      const errKey = (!res.ok && res.status === 404) ? 'invalid_token'
        : (!res.ok && res.status === 410) ? 'token_expired'
        : (!res.ok && res.status === 409) ? 'email_taken'
        : (!res.ok && res.status === 400) ? 'token_required'
        : 'unknown';
      errorMsg = ERROR_MESSAGES[errKey] ?? errorMsg;
    }
  } else {
    errorMsg = ERROR_MESSAGES['token_required']!;
  }

  return (
    <div style={{ minHeight: '100vh', background: '#09090B', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}>
      <div style={{ width: '100%', maxWidth: '400px', background: '#111116', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '12px', padding: '32px 28px' }}>
        <h1 style={{ fontFamily: 'monospace', fontSize: '16px', fontWeight: 700, color: 'rgba(245,240,235,0.85)', margin: '0 0 16px' }}>
          Email Verification
        </h1>
        {success ? (
          <>
            <p style={{ fontFamily: 'monospace', fontSize: '13px', color: '#2DD4A0', margin: '0 0 20px' }}>
              &#10003; Email address updated successfully.
            </p>
            <p style={{ fontFamily: 'monospace', fontSize: '11px', color: 'rgba(245,240,235,0.4)', margin: '0 0 20px' }}>
              Your account email has been changed. You may need to sign in again.
            </p>
          </>
        ) : (
          <p style={{ fontFamily: 'monospace', fontSize: '13px', color: '#FF4757', margin: '0 0 20px' }}>
            {errorMsg}
          </p>
        )}
        <Link href="/settings" style={{ fontFamily: 'monospace', fontSize: '12px', color: '#FF6B2B', textDecoration: 'none' }}>
          &#8592; Go to Settings
        </Link>
      </div>
    </div>
  );
}
