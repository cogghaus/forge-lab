import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { CreateTaskInput, EventEnvelope, Task } from '@forge-lab/core';

export interface TaskInstruction {
  id: string;
  taskId: string;
  workspaceId: string | null;
  priority: 'redirect' | 'stop';
  body: string;
  createdBy: string;
  acknowledgedAt: string | null;
  createdAt: string;
}

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
  contextDocs: Array<{ id: string; name: string; content: string; updatedAt: number }>;
}

export interface HubClientOptions {
  hubUrl: string;
  deviceToken: string;
  /**
   * Maximum WebSocket reconnect attempts after an unexpected disconnect.
   * 0 = no automatic reconnect (default: 10).
   */
  reconnectMaxAttempts?: number;
  /**
   * Base delay in ms for exponential back-off between reconnect attempts
   * (default: 1000). Actual delay = min(base * 2^attempt, maxDelay).
   */
  reconnectBaseDelayMs?: number;
  /**
   * Upper cap for reconnect delay in ms (default: 30000).
   */
  reconnectMaxDelayMs?: number;
  /**
   * Per-request timeout in ms for the HTTP API methods. A hub that accepts the
   * connection but never responds would otherwise hang a request (and the worker
   * poll loop calling it) forever. 0 disables the timeout. Default: 30000.
   */
  requestTimeoutMs?: number;
}

/**
 * Hub event emitted when the WebSocket disconnects unexpectedly.
 * Events: 'disconnect', 'reconnect', 'reconnect_failed', and all hub event names.
 */
export class HubClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private readonly opts: Required<HubClientOptions>;
  /** True once close() is called — suppresses automatic reconnect. */
  private _closed = false;
  /** Number of reconnect attempts since the last successful open. */
  private _reconnectAttempts = 0;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: HubClientOptions) {
    super();
    // Coalesce per-field so an explicit `undefined` (e.g. from spreading a
    // partial options object) falls back to the default rather than clobbering
    // it — a plain `{ ...defaults, ...opts }` would let `requestTimeoutMs:
    // undefined` silently disable the timeout this client exists to enforce.
    this.opts = {
      hubUrl: opts.hubUrl,
      deviceToken: opts.deviceToken,
      reconnectMaxAttempts: opts.reconnectMaxAttempts ?? 10,
      reconnectBaseDelayMs: opts.reconnectBaseDelayMs ?? 1000,
      reconnectMaxDelayMs: opts.reconnectMaxDelayMs ?? 30_000,
      requestTimeoutMs: opts.requestTimeoutMs ?? 30_000,
    };
  }

  /** Configured max reconnect attempts (Infinity = never give up). Read-only. */
  get reconnectMaxAttempts(): number {
    return this.opts.reconnectMaxAttempts;
  }

  async connect(): Promise<void> {
    this._closed = false;
    this._reconnectAttempts = 0;
    await this._openWebSocket(false);
  }

  close(): Promise<void> {
    this._closed = true;
    if (this._reconnectTimer !== null) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    return Promise.resolve();
  }

  // ---------------------------------------------------------------------------
  // Internal WebSocket lifecycle
  // ---------------------------------------------------------------------------

  private async _openWebSocket(isReconnect: boolean): Promise<void> {
    const base = new URL(this.opts.hubUrl);
    const wsProto = base.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProto}//${base.host}/ws?token=${encodeURIComponent(this.opts.deviceToken)}`;
    const ws = new WebSocket(wsUrl);
    this.ws = ws;

    if (!isReconnect) {
      // Initial connect: surface errors to the caller.
      // Also listen for 'close' so that calling close() mid-connect resolves
      // the promise rather than hanging indefinitely.
      await new Promise<void>((resolve, reject) => {
        const onOpen = () => {
          ws.removeListener('error', onError);
          ws.removeListener('close', onClose);
          this._reconnectAttempts = 0;
          resolve();
        };
        const onError = (err: Error) => {
          ws.removeListener('close', onClose);
          reject(err);
        };
        const onClose = () => {
          ws.removeListener('error', onError);
          reject(new Error('WebSocket closed before open'));
        };
        ws.once('open', onOpen);
        ws.once('error', onError);
        ws.once('close', onClose);
      });
      this._attachHandlers(ws);
    } else {
      // Reconnect: don't expose the promise — let the close handler retry on failure.
      // Must attach a no-op error listener to prevent unhandled error events during
      // reconnect attempts where the server may not be reachable yet.
      ws.on('error', () => {
        // Errors during reconnect are expected while the server is unavailable.
        // The close handler below will schedule the next retry.
      });
      ws.once('open', () => {
        this._reconnectAttempts = 0;
        this.emit('reconnect');
      });
      this._attachHandlers(ws);
    }
  }

  private _attachHandlers(ws: WebSocket): void {
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
        // ignore malformed messages
      }
    });

    ws.on('close', () => {
      // Guard: if this is a stale socket (replaced by a newer reconnect), skip.
      if (ws !== this.ws) return;
      this.emit('disconnect');
      if (!this._closed && this.opts.reconnectMaxAttempts > 0) {
        this._scheduleReconnect();
      }
    });
  }

  private _scheduleReconnect(): void {
    if (this._reconnectAttempts >= this.opts.reconnectMaxAttempts) {
      this.emit('reconnect_failed');
      return;
    }
    const delay = Math.min(
      this.opts.reconnectBaseDelayMs * Math.pow(2, this._reconnectAttempts),
      this.opts.reconnectMaxDelayMs,
    );
    this._reconnectAttempts++;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (this._closed) return;
      void this._openWebSocket(true);
    }, delay);
  }

  // ---------------------------------------------------------------------------
  // HTTP API methods
  // ---------------------------------------------------------------------------

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

  async failTask(id: string, reason?: string): Promise<void> {
    await this.request<{ ok: boolean }>('POST', `/tasks/${id}/fail`, { reason });
  }

  listInstructions(taskId: string): Promise<{ instructions: TaskInstruction[] }> {
    return this.request<{ instructions: TaskInstruction[] }>(
      'GET',
      `/tasks/${encodeURIComponent(taskId)}/instructions`,
    );
  }

  async ackInstruction(taskId: string, instrId: string): Promise<void> {
    await this.request<{ ok: boolean }>(
      'POST',
      `/tasks/${encodeURIComponent(taskId)}/instructions/${encodeURIComponent(instrId)}/ack`,
    );
  }

  async postComment(
    taskId: string,
    body: string,
    authorType: 'agent' | 'dispatcher' | 'system' = 'agent',
    authorId?: string,
  ): Promise<{ id: string }> {
    return this.request<{ id: string }>(
      'POST',
      `/tasks/${encodeURIComponent(taskId)}/comments`,
      { body, authorType, ...(authorId !== undefined && { authorId }) },
    );
  }

  // ---------------------------------------------------------------------------
  // FM / orchestrator methods
  // ---------------------------------------------------------------------------

  /** List workspaces the FM device is authorized to triage. Requires orchestrator device token. */
  listWorkspaces(): Promise<{ id: string }[]> {
    return this.request<{ id: string }[]>('GET', '/dispatcher/workspaces');
  }

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
    if (this.opts.requestTimeoutMs > 0) {
      init.signal = AbortSignal.timeout(this.opts.requestTimeoutMs);
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
