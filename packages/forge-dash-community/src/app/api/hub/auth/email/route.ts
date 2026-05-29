import type { NextRequest } from 'next/server';
import { hubFetch } from '@/lib/hub';
import { getSessionCookie, SESSION_COOKIE } from '@/lib/session';

export async function PATCH(req: NextRequest): Promise<Response> {
  const session = await getSessionCookie();
  if (!session) return Response.json({ error: 'unauthorized' }, { status: 401 });
  let body: { newEmail: string };
  try { body = await req.json() as typeof body; } catch { return Response.json({ error: 'invalid_json' }, { status: 400 }); }
  const res = await hubFetch<{ ok: boolean }>('/auth/email', {
    method: 'PATCH',
    body,
    cookie: `${SESSION_COOKIE}=${session}`,
  });
  if (!res.ok) return Response.json({ error: 'hub_error' }, { status: res.status || 500 });
  return Response.json(res.data);
}
