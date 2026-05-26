import { cookies } from 'next/headers';

export const SESSION_COOKIE = 'session';

export async function getSessionCookie(): Promise<string | null> {
  const store = await cookies();
  return store.get(SESSION_COOKIE)?.value ?? null;
}

// requireSession is kept for future server action use but not yet called.
// All current pages use getSessionCookie() + manual redirect() for SSR.
export async function requireSession(): Promise<string> {
  const session = await getSessionCookie();
  if (!session) throw new Error('no session');
  return session;
}
