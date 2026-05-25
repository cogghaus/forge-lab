import type { NextRequest } from 'next/server';
import { hubFetch, type HubTask } from '@/lib/hub';

/**
 * GET /api/hub/tasks?workspaceId=<id>
 *
 * Proxies the hub's /tasks endpoint, forwarding the caller's session cookie.
 * When workspaceId is provided, scopes the query to that workspace
 * (hub returns workspace tasks). Without it, returns unscoped (null workspaceId)
 * tasks only.
 *
 * Returns { tasks: HubTask[] } or { tasks: [] } on auth/network failure.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const cookie = req.headers.get('cookie') ?? '';
  const { searchParams } = new URL(req.url);
  const workspaceId = searchParams.get('workspaceId');

  const hubPath = workspaceId
    ? `/tasks?workspaceId=${encodeURIComponent(workspaceId)}`
    : '/tasks';

  const res = await hubFetch<{ tasks: HubTask[] }>(hubPath, { cookie });
  if (!res.ok) {
    return Response.json({ tasks: [] }, { status: res.status || 500 });
  }
  return Response.json(res.data);
}
