import { type NextRequest, NextResponse } from 'next/server';
import { SESSION_COOKIE } from '@/lib/session';

const PUBLIC_PATHS = ['/login'];

export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;
  const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  const hasSession = req.cookies.has(SESSION_COOKIE);

  if (!isPublic && !hasSession) {
    return NextResponse.redirect(new URL('/login', req.url));
  }
  if (isPublic && hasSession) {
    return NextResponse.redirect(new URL('/workspaces', req.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api).*)'],
};
