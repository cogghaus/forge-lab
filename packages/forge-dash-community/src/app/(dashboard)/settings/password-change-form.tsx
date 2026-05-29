'use client';

import { useActionState } from 'react';
import { changePasswordAction } from '@/actions/auth';

const INPUT_STYLE: React.CSSProperties = {
  background: 'rgba(255,255,255,0.06)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: '6px',
  padding: '8px 12px',
  fontSize: '13px',
  color: 'rgba(245,240,235,0.85)',
  outline: 'none',
  fontFamily: 'monospace',
  width: '100%',
  boxSizing: 'border-box',
};

const LABEL_STYLE: React.CSSProperties = {
  fontFamily: 'monospace',
  fontSize: '11px',
  color: 'rgba(245,240,235,0.4)',
  display: 'block',
  marginBottom: '6px',
};

function Field({
  id,
  name,
  label,
  placeholder,
}: {
  id: string;
  name: string;
  label: string;
  placeholder?: string;
}) {
  return (
    <div>
      <label htmlFor={id} style={LABEL_STYLE}>
        {label}
      </label>
      <input
        id={id}
        name={name}
        type="password"
        placeholder={placeholder}
        required
        style={INPUT_STYLE}
        onFocus={(e) => {
          e.currentTarget.style.border = '1px solid rgba(255,107,43,0.4)';
        }}
        onBlur={(e) => {
          e.currentTarget.style.border = '1px solid rgba(255,255,255,0.08)';
        }}
      />
    </div>
  );
}

export function PasswordChangeForm() {
  const [state, action, pending] = useActionState(changePasswordAction, {
    error: undefined,
    success: false,
  });

  return (
    <form action={action} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <Field id="currentPassword" name="currentPassword" label="Current password" />
      <Field id="newPassword" name="newPassword" label="New password" placeholder="Min 8 characters" />
      <Field id="confirmPassword" name="confirmPassword" label="Confirm new password" />

      {state.error && (
        <p
          style={{
            fontFamily: 'monospace',
            fontSize: '11px',
            color: '#FF4757',
            margin: 0,
          }}
        >
          {state.error}
        </p>
      )}

      {state.success && (
        <p
          style={{
            fontFamily: 'monospace',
            fontSize: '11px',
            color: '#2DD4A0',
            margin: 0,
          }}
        >
          &#10003; Password changed.
        </p>
      )}

      <div>
        <button
          type="submit"
          disabled={pending}
          style={{
            background: pending ? 'rgba(255,107,43,0.5)' : '#FF6B2B',
            border: 'none',
            borderRadius: '6px',
            padding: '6px 16px',
            fontFamily: 'monospace',
            fontSize: '12px',
            fontWeight: 600,
            color: '#ffffff',
            cursor: pending ? 'not-allowed' : 'pointer',
          }}
          onMouseEnter={(e) => {
            if (!pending) e.currentTarget.style.background = '#E85C1F';
          }}
          onMouseLeave={(e) => {
            if (!pending) e.currentTarget.style.background = '#FF6B2B';
          }}
        >
          {pending ? 'Saving...' : 'Change password'}
        </button>
      </div>
    </form>
  );
}
