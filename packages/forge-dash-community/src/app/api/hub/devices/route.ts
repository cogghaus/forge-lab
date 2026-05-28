import { NextRequest } from 'next/server';
import { hubFetch, type HubDevice } from '@/lib/hub';
import { getSessionCookie, SESSION_COOKIE } from '@/lib/session';

/**
 * GET /api/hub/devices[?includeDeregistered=true]
 *
 * Proxies the hub's /devices endpoint using the caller's server-side session.
 * Forwards the ?includeDeregistered=true query param when present.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const session = await getSessionCookie();
  if (!session) {
    return Response.json({ devices: [] }, { status: 401 });
  }
  const includeDeregistered = req.nextUrl.searchParams.get('includeDeregistered');
  const hubPath = includeDeregistered === 'true' ? '/devices?includeDeregistered=true' : '/devices';
  const res = await hubFetch<{ devices: HubDevice[] }>(hubPath, {
    cookie: `${SESSION_COOKIE}=${session}`,
  });
  if (!res.ok) {
    return Response.json({ devices: [] }, { status: res.status || 500 });
  }
  return Response.json(res.data);
}
