import type { NextRequest } from 'next/server';
import { hubFetch, type HubWorkspace } from '@/lib/hub';
import { getSessionCookie, SESSION_COOKIE } from '@/lib/session';

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/hub/workspaces/[id]
 *
 * Fetches a single workspace by ID.
 */
export async function GET(
  _req: NextRequest,
  { params }: Params,
): Promise<Response> {
  const { id } = await params;
  const session = await getSessionCookie();
  if (!session) return Response.json({ error: 'unauthorized' }, { status: 401 });

  const res = await hubFetch<HubWorkspace>(`/workspaces/${id}`, {
    cookie: `${SESSION_COOKIE}=${session}`,
  });
  if (!res.ok) return Response.json({ error: 'hub_error' }, { status: res.status || 500 });
  return Response.json(res.data);
}

/**
 * PATCH /api/hub/workspaces/[id]
 *
 * Updates workspace name and/or description.
 * Body: { name?: string; description?: string | null }
 */
export async function PATCH(
  req: NextRequest,
  { params }: Params,
): Promise<Response> {
  const { id } = await params;
  const session = await getSessionCookie();
  if (!session) return Response.json({ error: 'unauthorized' }, { status: 401 });

  type PatchBody = {
    name?: string;
    description?: string | null;
    repoUrl?: string | null;
    repoBranch?: string | null;
    status?: 'active' | 'archived';
  };
  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  const res = await hubFetch<{ ok: boolean }>(`/workspaces/${id}`, {
    method: 'PATCH',
    body,
    cookie: `${SESSION_COOKIE}=${session}`,
  });
  if (!res.ok) return Response.json({ error: 'hub_error' }, { status: res.status || 500 });
  return Response.json(res.data);
}

/**
 * DELETE /api/hub/workspaces/[id]
 *
 * Soft-deletes (archives to 'deleted') a workspace. Owner-only at the hub.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: Params,
): Promise<Response> {
  const { id } = await params;
  const session = await getSessionCookie();
  if (!session) return Response.json({ error: 'unauthorized' }, { status: 401 });

  const res = await hubFetch<{ ok: boolean }>(`/workspaces/${id}`, {
    method: 'DELETE',
    cookie: `${SESSION_COOKIE}=${session}`,
  });
  if (!res.ok) return Response.json({ error: 'hub_error' }, { status: res.status || 500 });
  return Response.json(res.data);
}
