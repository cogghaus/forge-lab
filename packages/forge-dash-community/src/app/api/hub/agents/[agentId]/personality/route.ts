import type { NextRequest } from 'next/server';
import { hubFetch, type HubPersonality } from '@/lib/hub';
import { getSessionCookie, SESSION_COOKIE } from '@/lib/session';

/** GET /api/hub/agents/[agentId]/personality — built-in personality, or 404. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ agentId: string }> },
): Promise<Response> {
  const { agentId } = await params;
  const session = await getSessionCookie();
  if (!session) return Response.json({ error: 'unauthorized' }, { status: 401 });

  const res = await hubFetch<HubPersonality>(`/agents/${encodeURIComponent(agentId)}/personality`, {
    cookie: `${SESSION_COOKIE}=${session}`,
  });
  if (!res.ok) {
    // 404 = this agent persona has no personality file; pass it through so the
    // UI can show a graceful "no personality defined" message.
    return Response.json({ error: 'no_personality' }, { status: res.status || 500 });
  }
  return Response.json(res.data);
}
