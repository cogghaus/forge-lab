import { NextRequest } from 'next/server';
import { hubFetch, type HubDevice } from '@/lib/hub';
import { getSessionCookie, SESSION_COOKIE } from '@/lib/session';

/** DELETE /api/hub/devices/:id - soft-deregister the device */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const session = await getSessionCookie();
  if (!session) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const res = await hubFetch(`/devices/${id}`, {
    method: 'DELETE',
    cookie: `${SESSION_COOKIE}=${session}`,
  });
  if (!res.ok) return Response.json({ error: 'hub_error' }, { status: res.status || 500 });
  return new Response(null, { status: 204 });
}

/** PATCH /api/hub/devices/:id - rename the device */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const session = await getSessionCookie();
  if (!session) return Response.json({ error: 'unauthorized' }, { status: 401 });
  let body: { name: string };
  try {
    body = (await req.json()) as { name: string };
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }
  const res = await hubFetch<HubDevice>(`/devices/${id}`, {
    method: 'PATCH',
    body: { name: body.name },
    cookie: `${SESSION_COOKIE}=${session}`,
  });
  if (!res.ok) return Response.json({ error: 'hub_error' }, { status: res.status || 500 });
  return Response.json(res.data);
}
