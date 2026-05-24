'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { hubFetch } from '@/lib/hub';
import { SESSION_COOKIE } from '@/lib/session';

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

export async function logoutAction(): Promise<void> {
  const cookieStore = await cookies();
  const session = cookieStore.get(SESSION_COOKIE)?.value;
  if (session) {
    await hubFetch('/auth/logout', { method: 'POST', cookie: `${SESSION_COOKIE}=${session}` });
  }
  cookieStore.delete(SESSION_COOKIE);
  redirect('/login');
}
