import { hubFetch, type HubDevice } from '@/lib/hub';
import { getSessionCookie, SESSION_COOKIE } from '@/lib/session';

/**
 * GET /api/hub/devices
 *
 * Proxies the hub's /devices endpoint using the caller's server-side session.
 * Reads the session token from the Next.js cookie store (not the raw browser
 * Cookie header, which contains multiple cookies separated by ";" — hubFetch
 * strips ";" as an injection guard, corrupting a multi-cookie header).
 * Returns { devices: HubDevice[] } or { devices: [] } on auth/network failure.
 */
export async function GET(): Promise<Response> {
  const session = await getSessionCookie();
  if (!session) {
    return Response.json({ devices: [] }, { status: 401 });
  }
  const res = await hubFetch<{ devices: HubDevice[] }>('/devices', {
    cookie: `${SESSION_COOKIE}=${session}`,
  });
  if (!res.ok) {
    return Response.json({ devices: [] }, { status: res.status || 500 });
  }
  return Response.json(res.data);
}
