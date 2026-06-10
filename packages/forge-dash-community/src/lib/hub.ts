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
    // Network error or timeout - return a synthetic error response so callers
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
  /** Optional git repo this workspace's worker agents check out + open PRs against. */
  repoUrl?: string | null;
  repoBranch?: string | null;
}

export interface HubPhaseInfo {
  phaseIndex: number;
  taskId?: string;
  title: string;
  role: string;
  status: 'pending' | 'active' | 'complete' | 'failed';
  result?: string;
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
  /** Set when this task is a sequenced multi-phase task. Null for plain tasks. */
  sequenceSpec?: { phases: Array<{ title: string; role: string; prompt: string }> } | null;
  /** Set when this task is a phase child. Null/undefined for root tasks. */
  phaseIndex?: number | null;
  /** Completion output written by the agent. */
  result?: string | null;
  /** Task IDs this task depends on (must complete before this task starts). */
  dependsOn?: string[];
  /** Human-readable reason this task is blocked. */
  blockedReason?: string | null;
  /** Assembled phase timeline for sequenced root tasks (response-only). */
  phases?: HubPhaseInfo[];
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
  /** Lifecycle status - active devices have valid tokens; deregistered devices are soft-deleted. */
  status: 'active' | 'deregistered';
}

/** A built-in agent personality (markdown system prompt + metadata). */
export interface HubPersonality {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
}

/** One of a user's authorized logins (browser/app session). */
export interface HubSession {
  id: string;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  expiresAt: string;
  /** True for the session making the current request. */
  current: boolean;
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

/** A comment on a task - posted by a user, agent, dispatcher, or system. */
export interface HubTaskComment {
  id: string;
  taskId: string;
  authorId: string;
  authorType: 'user' | 'agent' | 'dispatcher' | 'system';
  body: string;
  createdAt: string;
}

export type DocCategory = 'architecture' | 'api' | 'pattern' | 'adr' | 'agent' | 'feature' | 'runbook';
export type DocStatus = 'active' | 'archived' | 'superseded';

export interface HubWorkspaceDoc {
  id: string;
  workspaceId: string;
  key: string;
  title: string;
  content: string;
  category: DocCategory;
  status: DocStatus;
  supersededById: string | null;
  supersededReason: string | null;
  updatedBy: string;
  updatedAt: string;
  createdAt: string;
}

export interface HubAgentPerf {
  agentId: string;
  completedCount: number;
  failedCount: number;
  inProgressCount: number;
  totalCount: number;
  /** Percentage 0-100, rounded to 2dp */
  failureRate: number;
  /** Milliseconds, or null if no completed tasks with timing data */
  avgCompletionTimeMs: number | null;
  /** Completed tasks per day over the window */
  throughputPerDay: number;
}

export interface HubAgentPerfResponse {
  agents: HubAgentPerf[];
  windowDays: number;
  generatedAt: string;
}

export interface HubAgent {
  id: string;
  name: string;
  workspaceId: string | null;
  runtimeId: string;
  createdAt: string;
}

export interface HubAnalyticsOverview {
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  pendingTasks: number;
  inProgressTasks: number;
  cancelledTasks: number;
  completionRate: number;
  avgCompletionTimeMs: number | null;
  period: { from: string | null; to: string | null };
}

export type TaskStatus =
  | 'pending_dispatcher_action'
  | 'pending_design'
  | 'design_review'
  | 'pending_agent'
  | 'assigned'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';

/** Statuses from which a user may trigger Cancel (via POST /cancel endpoint). */
export const CANCELLABLE_STATUSES: TaskStatus[] = [
  'pending_dispatcher_action',
  'pending_design',
  'design_review',
  'pending_agent',
  'assigned',
  'in_progress',
];

/** Statuses from which a user may retry via the dedicated /retry endpoint (→ pending_dispatcher_action). */
export const RETRIABLE_STATUSES: TaskStatus[] = ['failed'];

/** Statuses from which a user may reassign the agent (user session path). */
export const REASSIGNABLE_STATUSES: TaskStatus[] = ['pending_agent', 'assigned'];
