import type { NextRequest } from 'next/server';
import { hubFetch, type HubAnalyticsOverview } from '@/lib/hub';
import { getSessionCookie, SESSION_COOKIE } from '@/lib/session';

/**
 * GET /api/hub/workspaces/[id]/analytics
 *
 * Proxies hub GET /workspaces/:id/analytics/overview.
 * Forwards from/to query params when present.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const session = await getSessionCookie();
  if (!session) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const from = searchParams.get('from');
  const to = searchParams.get('to');

  const qs = new URLSearchParams();
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);
  const query = qs.toString();
  const hubPath = `/workspaces/${id}/analytics/overview${query ? `?${query}` : ''}`;

  const res = await hubFetch<HubAnalyticsOverview>(hubPath, {
    cookie: `${SESSION_COOKIE}=${session}`,
  });

  if (!res.ok) {
    return Response.json({ error: 'hub_error' }, { status: res.status || 500 });
  }
  return Response.json(res.data);
}
