import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { CreateTaskInput, EventEnvelope, Task } from '@forge-lab/core';

export interface WorkspaceContext {
  workspaceId: string;
  docs: unknown[];
  goals: unknown[];
  agents: unknown[];
  liveInstances: unknown[];
  inboxTasks: Task[];
  recentHistory: unknown[];
  dispatcherHistory: unknown[];
  queueDepth: Record<string, number>;
}

export interface HubClientOptions {
  hubUrl: string;
  deviceToken: string;
}

export class HubClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private readonly opts: HubClientOptions;

  constructor(opts: HubClientOptions) {
    super();
    this.opts = opts;
  }

  async connect(): Promise<void> {
    const base = new URL(this.opts.hubUrl);
    const wsProto = base.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProto}//${base.host}/ws?token=${encodeURIComponent(this.opts.deviceToken)}`;
    const ws = new WebSocket(wsUrl);
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', (err) => reject(err));
    });
    ws.on('message', (data: WebSocket.RawData) => {
      try {
        const text =
          typeof data === 'string'
            ? data
            : data instanceof Buffer
              ? data.toString('utf8')
              : Buffer.from(data as ArrayBuffer).toString('utf8');
        const msg = JSON.parse(text) as Partial<EventEnvelope> & { name?: string };
        if (msg.name) {
          this.emit('event', msg as EventEnvelope);
          this.emit(msg.name, msg as EventEnvelope);
        }
      } catch {
        // ignore
      }
    });
    ws.on('close', () => {
      this.emit('disconnect');
    });
  }

  close(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    return Promise.resolve();
  }

  createTask(input: CreateTaskInput): Promise<{ id: string }> {
    return this.request<{ id: string }>('POST', '/tasks', input);
  }

  getTask(id: string): Promise<Task> {
    return this.request<Task>('GET', `/tasks/${id}`);
  }

  listTasks(workspaceId?: string): Promise<{ tasks: Task[] }> {
    const path = workspaceId
      ? `/tasks?workspaceId=${encodeURIComponent(workspaceId)}`
      : '/tasks';
    return this.request<{ tasks: Task[] }>('GET', path);
  }

  async claimTask(id: string): Promise<void> {
    await this.request<{ ok: boolean }>('POST', `/tasks/${id}/claim`);
  }

  async completeTask(id: string, result?: string): Promise<void> {
    await this.request<{ ok: boolean }>('POST', `/tasks/${id}/complete`, { result });
  }

  // ---------------------------------------------------------------------------
  // FM / orchestrator methods
  // ---------------------------------------------------------------------------

  /** Assign a task to a specific agentId. Requires orchestrator device token. */
  async assignTask(workspaceId: string, taskId: string, agentId: string): Promise<void> {
    await this.request<{ ok: boolean }>(
      'PATCH',
      `/workspaces/${encodeURIComponent(workspaceId)}/tasks/${encodeURIComponent(taskId)}/assign`,
      { agentId },
    );
  }

  /** Fetch the Tier 0 context bundle for FM triage. Requires orchestrator device token. */
  getWorkspaceContext(workspaceId: string): Promise<WorkspaceContext> {
    return this.request<WorkspaceContext>(
      'GET',
      `/workspaces/${encodeURIComponent(workspaceId)}/context`,
    );
  }

  /** List tasks in assigned status beyond ttlMinutes. Requires orchestrator device token. */
  getStaleAssigned(
    workspaceId: string,
    ttlMinutes = 30,
  ): Promise<{ tasks: Task[]; ttlMinutes: number; cutoff: string }> {
    return this.request<{ tasks: Task[]; ttlMinutes: number; cutoff: string }>(
      'GET',
      `/workspaces/${encodeURIComponent(workspaceId)}/tasks/stale-assigned?ttlMinutes=${ttlMinutes}`,
    );
  }

  /** Bulk-requeue stale assigned tasks back to pending_dispatcher_action. Requires orchestrator token. */
  requeueStaleAssigned(
    workspaceId: string,
    ttlMinutes = 30,
  ): Promise<{ requeued: number }> {
    return this.request<{ requeued: number }>(
      'POST',
      `/workspaces/${encodeURIComponent(workspaceId)}/tasks/stale-assigned/requeue?ttlMinutes=${ttlMinutes}`,
    );
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = new URL(path, this.opts.hubUrl);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.opts.deviceToken}`,
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetch(url, init);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${method} ${path} ${res.status}: ${text}`);
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : null) as T;
  }
}
