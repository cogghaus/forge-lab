import type { NextRequest } from 'next/server';
import { hubFetch, type HubAgentPerfResponse } from '@/lib/hub';
import { getSessionCookie, SESSION_COOKIE } from '@/lib/session';

/**
 * GET /api/hub/agents/performance?window=30&workspaceId=<id>
 *
 * Proxies the hub's /agents/performance endpoint using the caller's session.
 * window = number of days (1-365, default 30).
 * workspaceId is optional; omit to see cross-workspace metrics.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const session = await getSessionCookie();
  if (!session) {
    return Response.json({ agents: [], windowDays: 30, generatedAt: new Date().toISOString() }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const window = searchParams.get('window');
  const workspaceId = searchParams.get('workspaceId');

  const from = searchParams.get('from');
  const to = searchParams.get('to');

  const params = new URLSearchParams();
  if (window) params.set('window', window);
  if (workspaceId) params.set('workspaceId', workspaceId);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  const qs = params.toString();
  const hubPath = `/agents/performance${qs ? `?${qs}` : ''}`;

  const res = await hubFetch<HubAgentPerfResponse>(hubPath, {
    cookie: `${SESSION_COOKIE}=${session}`,
  });

  if (!res.ok) {
    return Response.json(
      { agents: [], windowDays: Number(window ?? 30), generatedAt: new Date().toISOString() },
      { status: res.status || 500 },
    );
  }
  return Response.json(res.data);
}
