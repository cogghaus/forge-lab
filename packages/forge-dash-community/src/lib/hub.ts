const HUB_URL = process.env['FORGE_HUB_URL'] ?? 'http://localhost:3000';

export type HubResponse<T> =
  | { ok: true;  data: T;       status: number; setCookie?: string }
  | { ok: false; data: unknown; status: number; setCookie?: string };

/** Network timeout for hub requests (ms). Prevents SSR from hanging if hub is slow. */
const HUB_FETCH_TIMEOUT_MS = 5_000;

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

  let res: Response;
  try {
    res = await fetch(`${HUB_URL}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      cache: 'no-store',
      signal: AbortSignal.timeout(HUB_FETCH_TIMEOUT_MS),
    });
  } catch {
    // Network error or timeout — return a synthetic error response so callers
    // can degrade gracefully instead of crashing the SSR render.
    return { ok: false, data: null, status: 0 };
  }

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
  createdAt: string;
  role: string;
  /** Monthly budget allocation in US cents (0 = unlimited / unset). */
  budgetMonthlyCents: number;
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
  createdAt: string;
  completedAt: string | null;
}

export interface HubGoal {
  id: string;
  workspaceId: string;
  parentId: string | null;
  title: string;
  description: string | null;
  status: 'active' | 'completed' | 'cancelled';
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface HubTaskHistory {
  id: string;
  taskId: string;
  eventName: string;
  source: string;
  payload: unknown;
  createdAt: string;
}

export interface HubActivityEvent {
  id: string;
  taskId: string;
  taskTitle: string;
  eventName: string;
  source: string;
  payload: unknown;
  createdAt: string;
}

export interface HubRuntimeConfig {
  id: string;
  userId: string;
  runtimeId: string;
  name: string;
  config: Record<string, unknown>;
  createdAt: string;
}

export interface HubMe {
  id: string;
  email: string;
  role: string;
}

export interface HubTaskStats {
  total: number;
  byStatus: Record<string, number>;
  completionRate: number;
  completedLast7Days: number;
  summary: {
    completed: number;
    failed: number;
    inProgress: number;
    pending: number;
  };
}

export interface HubDevice {
  id: string;
  name: string;
  hostname: string | null;
  platform: string | null;
  lastSeen: string | null;
  createdAt: string;
  deviceType: 'worker' | 'orchestrator';
  agentId: string | null;
}

/** A single dispatcher decision comment from the FM triage log. */
export interface HubDispatcherComment {
  id: string;
  taskId: string;
  taskTitle: string;
  body: string;
  authorId: string;
  createdAt: string;
}

export interface HubDispatcherLog {
  comments: HubDispatcherComment[];
  inboxCount: number;
}

/** Shape returned by HubTask with parentId field. */
export interface HubTaskWithParent extends HubTask {
  parentId: string | null;
}
