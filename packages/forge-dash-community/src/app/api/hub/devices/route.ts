import type { NextRequest } from 'next/server';
import { hubFetch, type HubDevice } from '@/lib/hub';

/**
 * GET /api/hub/devices
 *
 * Proxies the hub's /devices endpoint, forwarding the caller's session cookie.
 * Returns { devices: HubDevice[] } or { devices: [] } on auth/network failure.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const cookie = req.headers.get('cookie') ?? '';
  const res = await hubFetch<{ devices: HubDevice[] }>('/devices', { cookie });
  if (!res.ok) {
    // Hub unavailable or unauthenticated — return empty list so the UI
    // degrades gracefully (shows no devices) rather than erroring.
    return Response.json({ devices: [] }, { status: res.status || 500 });
  }
  return Response.json(res.data);
}
