import type { NextRequest } from 'next/server';
import { hubFetch } from '@/lib/hub';
import { getSessionCookie, SESSION_COOKIE } from '@/lib/session';

type Params = { params: Promise<{ id: string; ruleId: string }> };

export async function PATCH(req: NextRequest, { params }: Params): Promise<Response> {
  const { id, ruleId } = await params;
  const session = await getSessionCookie();
  if (!session) return Response.json({ error: 'unauthorized' }, { status: 401 });
  let body: unknown;
  try { body = await req.json(); } catch { return Response.json({ error: 'invalid_json' }, { status: 400 }); }
  const res = await hubFetch<unknown>(`/workspaces/${id}/policy-rules/${ruleId}`, {
    method: 'PATCH',
    body,
    cookie: `${SESSION_COOKIE}=${session}`,
  });
  if (!res.ok) return Response.json({ error: 'hub_error' }, { status: res.status || 500 });
  return Response.json(res.data);
}
