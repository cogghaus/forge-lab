import type { NextRequest } from 'next/server';
import { hubFetch, type HubTask } from '@/lib/hub';
import { getSessionCookie, SESSION_COOKIE } from '@/lib/session';

/**
 * GET /api/hub/tasks?workspaceId=<id>
 *
 * Proxies the hub's /tasks endpoint using the caller's server-side session.
 * Reads the session token from the Next.js cookie store (not the raw browser
 * Cookie header — see /api/hub/devices for explanation of why).
 * When workspaceId is provided, scopes the query to that workspace.
 *
 * Returns { tasks: HubTask[] } or { tasks: [] } on auth/network failure.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const session = await getSessionCookie();
  if (!session) {
    return Response.json({ tasks: [] }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const workspaceId = searchParams.get('workspaceId');

  const hubPath = workspaceId
    ? `/tasks?workspaceId=${encodeURIComponent(workspaceId)}`
    : '/tasks';

  const res = await hubFetch<{ tasks: HubTask[] }>(hubPath, {
    cookie: `${SESSION_COOKIE}=${session}`,
  });
  if (!res.ok) {
    return Response.json({ tasks: [] }, { status: res.status || 500 });
  }
  return Response.json(res.data);
}
