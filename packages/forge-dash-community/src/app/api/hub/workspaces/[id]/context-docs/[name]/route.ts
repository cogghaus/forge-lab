import type { NextRequest } from 'next/server';
import { hubFetch } from '@/lib/hub';
import { getSessionCookie, SESSION_COOKIE } from '@/lib/session';

type Params = { params: Promise<{ id: string; name: string }> };

export async function GET(_req: NextRequest, { params }: Params): Promise<Response> {
  const { id, name } = await params;
  const session = await getSessionCookie();
  if (!session) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const res = await hubFetch<unknown>(`/workspaces/${id}/context-docs/${encodeURIComponent(name)}`, {
    cookie: `${SESSION_COOKIE}=${session}`,
  });
  if (!res.ok) return Response.json({ error: 'hub_error' }, { status: res.status || 500 });
  return Response.json(res.data);
}

export async function PUT(req: NextRequest, { params }: Params): Promise<Response> {
  const { id, name } = await params;
  const session = await getSessionCookie();
  if (!session) return Response.json({ error: 'unauthorized' }, { status: 401 });
  let body: unknown;
  try { body = await req.json(); } catch { return Response.json({ error: 'invalid_json' }, { status: 400 }); }
  const res = await hubFetch<unknown>(`/workspaces/${id}/context-docs/${encodeURIComponent(name)}`, {
    method: 'PUT',
    body,
    cookie: `${SESSION_COOKIE}=${session}`,
  });
  if (!res.ok) return Response.json(res.data ?? { error: 'hub_error' }, { status: res.status || 500 });
  return Response.json(res.data, { status: res.status });
}

export async function DELETE(_req: NextRequest, { params }: Params): Promise<Response> {
  const { id, name } = await params;
  const session = await getSessionCookie();
  if (!session) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const res = await hubFetch<unknown>(`/workspaces/${id}/context-docs/${encodeURIComponent(name)}`, {
    method: 'DELETE',
    cookie: `${SESSION_COOKIE}=${session}`,
  });
  if (!res.ok) return Response.json({ error: 'hub_error' }, { status: res.status || 500 });
  return Response.json(res.data);
}
