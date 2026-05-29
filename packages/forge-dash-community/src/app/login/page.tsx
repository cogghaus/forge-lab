'use client';

import { useActionState, useState } from 'react';
import { loginAction } from '@/actions/auth';

const initialState = { error: undefined as string | undefined };

export default function LoginPage() {
  const [state, action, pending] = useActionState(loginAction, initialState);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  return (
    <div
      style={{
        minHeight: '100vh',
        background: '#09090B',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '16px',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: '360px',
          background: '#111116',
          border: '1px solid rgba(255,255,255,0.06)',
          borderRadius: '12px',
          padding: '28px 24px',
        }}
      >
        {/* Header */}
        <div style={{ marginBottom: '24px' }}>
          <h1
            style={{
              fontFamily: 'monospace',
              fontSize: '16px',
              fontWeight: 700,
              color: 'rgba(245,240,235,0.85)',
              margin: 0,
              marginBottom: '6px',
            }}
          >
            Forge Lab
          </h1>
          <p
            style={{
              fontFamily: 'monospace',
              fontSize: '11px',
              color: 'rgba(245,240,235,0.4)',
              margin: 0,
            }}
          >
            Access is by invitation only. Contact your admin for credentials.
          </p>
        </div>

        <form action={action} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {/* Error */}
          {state.error && (
            <div
              style={{
                background: 'rgba(255,71,87,0.12)',
                border: '1px solid rgba(255,71,87,0.25)',
                borderRadius: '6px',
                padding: '8px 12px',
                color: '#FF4757',
                fontFamily: 'monospace',
                fontSize: '11px',
              }}
            >
              {state.error}
            </div>
          )}

          {/* Dev shortcut */}
          {process.env.NODE_ENV === 'development' && (
            <button
              type="button"
              onClick={() => {
                setEmail('dev@forge-lab.local');
                setPassword('forgelab123');
              }}
              style={{
                background: 'rgba(255,255,255,0.06)',
                border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: '6px',
                padding: '8px 12px',
                textAlign: 'left',
                fontFamily: 'monospace',
                fontSize: '11px',
                color: 'rgba(245,240,235,0.4)',
                cursor: 'pointer',
              }}
            >
              dev: dev@forge-lab.local / forgelab123
            </button>
          )}

          {/* Email */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label
              htmlFor="email"
              style={{
                fontFamily: 'monospace',
                fontSize: '11px',
                color: 'rgba(245,240,235,0.4)',
              }}
            >
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              placeholder="you@example.com"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={{
                background: 'rgba(255,255,255,0.06)',
                border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: '6px',
                padding: '8px 12px',
                fontSize: '13px',
                color: 'rgba(245,240,235,0.85)',
                outline: 'none',
                fontFamily: 'monospace',
              }}
              onFocus={(e) => {
                e.currentTarget.style.border = '1px solid rgba(255,107,43,0.4)';
              }}
              onBlur={(e) => {
                e.currentTarget.style.border = '1px solid rgba(255,255,255,0.08)';
              }}
            />
          </div>

          {/* Password */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label
              htmlFor="password"
              style={{
                fontFamily: 'monospace',
                fontSize: '11px',
                color: 'rgba(245,240,235,0.4)',
              }}
            >
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              placeholder="Password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={{
                background: 'rgba(255,255,255,0.06)',
                border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: '6px',
                padding: '8px 12px',
                fontSize: '13px',
                color: 'rgba(245,240,235,0.85)',
                outline: 'none',
                fontFamily: 'monospace',
              }}
              onFocus={(e) => {
                e.currentTarget.style.border = '1px solid rgba(255,107,43,0.4)';
              }}
              onBlur={(e) => {
                e.currentTarget.style.border = '1px solid rgba(255,255,255,0.08)';
              }}
            />
          </div>

          {/* Submit */}
          <button
            type="submit"
            disabled={pending}
            style={{
              background: pending ? 'rgba(255,107,43,0.5)' : '#FF6B2B',
              border: 'none',
              borderRadius: '6px',
              padding: '10px 16px',
              fontFamily: 'monospace',
              fontSize: '12px',
              fontWeight: 600,
              color: '#ffffff',
              cursor: pending ? 'not-allowed' : 'pointer',
              width: '100%',
              marginTop: '4px',
            }}
            onMouseEnter={(e) => {
              if (!pending) e.currentTarget.style.background = '#E85C1F';
            }}
            onMouseLeave={(e) => {
              if (!pending) e.currentTarget.style.background = '#FF6B2B';
            }}
          >
            {pending ? 'Signing in...' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
