import { type NextRequest, NextResponse } from 'next/server';
import { getSessionCookie, SESSION_COOKIE } from '@/lib/session';

const HUB_URL = process.env['FORGE_HUB_URL'] ?? 'http://localhost:3000';

/**
 * GET /api/hub/events
 *
 * Proxies the hub's SSE `/events` endpoint to the browser. Forwards the
 * session cookie for authentication and streams the response body unchanged.
 *
 * Query params are forwarded as-is (e.g. `?workspaceId=...`).
 *
 * Returns 401 if the session cookie is missing, 502 if the hub is unreachable.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const session = await getSessionCookie();
  if (!session) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const search = req.nextUrl.search; // e.g. "?workspaceId=abc"
  const hubUrl = `${HUB_URL}/events${search}`;

  let hubRes: Response;
  try {
    hubRes = await fetch(hubUrl, {
      headers: {
        cookie: `${SESSION_COOKIE}=${session}`,
        // Signal to the hub that this is a trusted internal proxy call.
        'x-forwarded-for': req.headers.get('x-forwarded-for') ?? '',
      },
      // No AbortSignal.timeout() — SSE connections are intentionally long-lived.
    });
  } catch {
    return NextResponse.json({ error: 'hub_unreachable' }, { status: 502 });
  }

  if (!hubRes.ok) {
    // Preserve the hub error body (JSON) so the client gets a useful error
    // message instead of an empty response. This also prevents EventSource
    // from entering a reconnect loop on 403/4xx — it receives a body and can
    // inspect the status rather than treating the empty response as a network error.
    const body = hubRes.body ?? null;
    const ct = hubRes.headers.get('content-type') ?? 'application/json';
    return new Response(body, { status: hubRes.status, headers: { 'Content-Type': ct } });
  }

  if (!hubRes.body) {
    return new Response(null, { status: 502 });
  }

  // Pipe the hub SSE stream directly to the browser.
  return new Response(hubRes.body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
