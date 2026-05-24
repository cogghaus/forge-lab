const HUB_URL = process.env['FORGE_HUB_URL'] ?? 'http://localhost:3000';

export type HubResponse<T> =
  | { ok: true;  data: T;       status: number; setCookie?: string }
  | { ok: false; data: unknown; status: number; setCookie?: string };

export async function hubFetch<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    cookie?: string;
  } = {},
): Promise<HubResponse<T>> {
  const headers: Record<string, string> = {};
  // Strip header-injection chars (CRLF, NUL) and cookie-separator (;)
  if (options.cookie) headers['cookie'] = options.cookie.replace(/[\r\n\0;]/g, '');
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${HUB_URL}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    cache: 'no-store',
  });

  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try { parsed = JSON.parse(text); } catch { /* leave parsed as null */ }
  }

  const setCookie = res.headers.get('set-cookie') ?? undefined;

  if (res.ok) {
    return { ok: true, data: parsed as T, status: res.status, setCookie };
  }
  return { ok: false, data: parsed, status: res.status, setCookie };
}

export interface HubWorkspace {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  status: string;
  createdAt: number;
  role: string;
}

export interface HubTask {
  id: string;
  workspaceId: string | null;
  projectPrefix: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  assignedDeviceId: string | null;
  assignedAgentId: string | null;
  goalId: string | null;
  createdBy: string;
  createdAt: number;
  completedAt: number | null;
}

export interface HubGoal {
  id: string;
  workspaceId: string;
  parentId: string | null;
  title: string;
  description: string | null;
  status: 'active' | 'completed' | 'cancelled';
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface HubTaskHistory {
  id: string;
  taskId: string;
  eventName: string;
  source: string;
  payload: unknown;
  createdAt: number;
}
