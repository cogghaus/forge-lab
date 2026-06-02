import type { NextRequest } from 'next/server';
import { hubFetch } from '@/lib/hub';
import { getSessionCookie, SESSION_COOKIE } from '@/lib/session';

/** DELETE /api/hub/auth/sessions/[id] — revoke one of the user's logins. */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const session = await getSessionCookie();
  if (!session) return Response.json({ error: 'unauthorized' }, { status: 401 });

  const res = await hubFetch<{ ok: boolean }>(`/auth/sessions/${id}`, {
    method: 'DELETE',
    cookie: `${SESSION_COOKIE}=${session}`,
  });
  if (!res.ok) return Response.json({ error: 'hub_error' }, { status: res.status || 500 });
  return Response.json(res.data);
}
