import { hubFetch } from '@/lib/hub';
import { getSessionCookie, SESSION_COOKIE } from '@/lib/session';

/** POST /api/hub/auth/sessions/revoke-others — sign out every other login. */
export async function POST(): Promise<Response> {
  const session = await getSessionCookie();
  if (!session) return Response.json({ error: 'unauthorized' }, { status: 401 });

  const res = await hubFetch<{ ok: boolean; revoked: number }>('/auth/sessions/revoke-others', {
    method: 'POST',
    cookie: `${SESSION_COOKIE}=${session}`,
  });
  if (!res.ok) return Response.json({ error: 'hub_error' }, { status: res.status || 500 });
  return Response.json(res.data);
}
