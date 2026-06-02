import { hubFetch, type HubSession } from '@/lib/hub';
import { getSessionCookie, SESSION_COOKIE } from '@/lib/session';

/** GET /api/hub/auth/sessions — list the current user's authorized logins. */
export async function GET(): Promise<Response> {
  const session = await getSessionCookie();
  if (!session) return Response.json({ error: 'unauthorized' }, { status: 401 });

  const res = await hubFetch<{ sessions: HubSession[] }>('/auth/sessions', {
    cookie: `${SESSION_COOKIE}=${session}`,
  });
  if (!res.ok) return Response.json({ error: 'hub_error' }, { status: res.status || 500 });
  return Response.json(res.data);
}
