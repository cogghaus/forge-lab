import type { NextRequest } from 'next/server';
import { hubFetch, type HubAgent } from '@/lib/hub';
import { getSessionCookie, SESSION_COOKIE } from '@/lib/session';

/**
 * GET /api/hub/agents?workspaceId=<id>
 *
 * Proxies GET /workspaces/:workspaceId/agents using the caller's session.
 * Returns the list of agents registered to the workspace.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const session = await getSessionCookie();
  if (!session) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const workspaceId = new URL(req.url).searchParams.get('workspaceId');
  if (!workspaceId) {
    return Response.json({ error: 'workspaceId required' }, { status: 400 });
  }

  const res = await hubFetch<{ agents: HubAgent[] }>(
    `/workspaces/${workspaceId}/agents`,
    { cookie: `${SESSION_COOKIE}=${session}` },
  );

  if (!res.ok) {
    return Response.json({ agents: [] }, { status: res.status || 500 });
  }
  return Response.json(res.data);
}
