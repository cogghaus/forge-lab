import type { NextRequest } from 'next/server';
import { hubFetch } from '@/lib/hub';

export async function GET(req: NextRequest): Promise<Response> {
  const token = req.nextUrl.searchParams.get('token');
  if (!token) return Response.json({ error: 'token_required' }, { status: 400 });
  const res = await hubFetch<{ ok: boolean }>(`/auth/email/verify?token=${encodeURIComponent(token)}`);
  if (!res.ok) return Response.json({ error: 'hub_error' }, { status: res.status || 500 });
  return Response.json(res.data);
}
