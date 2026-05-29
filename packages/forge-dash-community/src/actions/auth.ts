'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { hubFetch } from '@/lib/hub';
import { getSessionCookie, SESSION_COOKIE } from '@/lib/session';

type LoginState = { error: string | undefined };

export async function loginAction(_prevState: LoginState, formData: FormData): Promise<LoginState> {
  const email = formData.get('email') as string;
  const password = formData.get('password') as string;

  const res = await hubFetch<{ error?: string }>('/auth/login', {
    method: 'POST',
    body: { email, password },
  });

  if (!res.ok) {
    return { error: 'Invalid email or password.' } satisfies LoginState;
  }

  if (res.setCookie) {
    const nameVal = res.setCookie.split(';')[0] ?? '';
    const eqIdx = nameVal.indexOf('=');
    const val = eqIdx >= 0 ? nameVal.slice(eqIdx + 1) : '';
    if (val) {
      const cookieStore = await cookies();
      cookieStore.set(SESSION_COOKIE, val, {
        httpOnly: true,
        path: '/',
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
      });
    }
  }

  redirect('/workspaces');
}

type ChangePasswordState = { error: string | undefined; success: boolean };

export async function changePasswordAction(
  _prev: ChangePasswordState,
  formData: FormData,
): Promise<ChangePasswordState> {
  const currentPassword = formData.get('currentPassword') as string;
  const newPassword = formData.get('newPassword') as string;
  const confirmPassword = formData.get('confirmPassword') as string;

  if (newPassword !== confirmPassword) {
    return { error: 'New passwords do not match.', success: false };
  }
  if (newPassword.length < 8) {
    return { error: 'New password must be at least 8 characters.', success: false };
  }

  const session = await getSessionCookie();
  if (!session) return { error: 'Not authenticated.', success: false };

  const res = await hubFetch<{ ok: boolean }>('/auth/password', {
    method: 'PATCH',
    body: { currentPassword, newPassword },
    cookie: `${SESSION_COOKIE}=${session}`,
  });

  if (!res.ok) {
    if (res.status === 401) return { error: 'Current password is incorrect.', success: false };
    return { error: 'Failed to change password. Try again.', success: false };
  }
  return { error: undefined, success: true };
}

type ChangeEmailState = { error: string | undefined; success: boolean };

export async function changeEmailAction(
  _prev: ChangeEmailState,
  formData: FormData,
): Promise<ChangeEmailState> {
  const newEmail = (formData.get('newEmail') as string)?.trim();
  if (!newEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
    return { error: 'Valid email address required.', success: false };
  }
  const session = await getSessionCookie();
  if (!session) return { error: 'Not authenticated.', success: false };
  const res = await hubFetch<{ ok: boolean }>('/auth/email', {
    method: 'PATCH',
    body: { newEmail },
    cookie: `${SESSION_COOKIE}=${session}`,
  });
  if (!res.ok) {
    if (res.status === 409) return { error: 'That email is already in use.', success: false };
    return { error: 'Failed to update email. Try again.', success: false };
  }
  return { error: undefined, success: true };
}

export async function logoutAction(): Promise<void> {
  const cookieStore = await cookies();
  const session = cookieStore.get(SESSION_COOKIE)?.value;
  if (session) {
    await hubFetch('/auth/logout', { method: 'POST', cookie: `${SESSION_COOKIE}=${session}` });
  }
  cookieStore.delete(SESSION_COOKIE);
  redirect('/login');
}
