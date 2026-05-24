const HUB_URL = process.env['FORGE_HUB_URL'] ?? 'http://localhost:3000';

export interface HubResponse<T> {
  data: T;
  status: number;
  ok: boolean;
  setCookie?: string;
}

export async function hubFetch<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    cookie?: string;
  } = {},
): Promise<HubResponse<T>> {
  const headers: Record<string, string> = {};
  if (options.cookie) headers['cookie'] = options.cookie;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${HUB_URL}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    cache: 'no-store',
  });

  const text = await res.text();
  let data: T;
  try {
    data = (text ? (JSON.parse(text) as T) : null) as T;
  } catch {
    data = null as T;
  }
  const setCookie = res.headers.get('set-cookie') ?? undefined;
  return { data, status: res.status, ok: res.ok, setCookie };
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
