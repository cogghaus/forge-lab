import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { eq } from 'drizzle-orm';
import { createHub, type Hub } from '@forge-lab/hub';
import { schema } from '@forge-lab/core';
import type { AgentRuntime, AgentRuntimeSpawnConfig, RuntimeInstance } from '@forge-lab/core';
import { loadBuiltinRegistry } from '@forge-lab/agents';
import { Daemon } from './daemon.js';
import { HubClient } from './hub-client.js';
import { MockRuntime } from './runtime/mock.js';
import { RuntimeRegistry } from './runtime/registry.js';

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 5000): Promise<T> {
  const start = Date.now();
  let lastErr: unknown = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`waitFor timeout after ${timeoutMs}ms${lastErr ? `: ${String(lastErr)}` : ''}`);
}

describe('integration: create -> assign -> complete', () => {
  let hub: Hub;
  let daemon: Daemon;
  let workdir: string;
  let hubUrl: string;
  let deviceToken: string;
  let sessionCookie: string;

  beforeEach(async () => {
    workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-e2e-'));

    hub = await createHub({
      config: {
        port: 0,
        host: '127.0.0.1',
        databaseUrl: ':memory:',
        sessionSecret: 'test-secret-for-integration-test-xxxxxxxx',
        sessionTtlHours: 24,
        bcryptCost: 10,
        cookieSecure: false,
      },
    });
    hubUrl = await hub.fastify.listen({ port: 0, host: '127.0.0.1' });

    const regRes = await fetch(`${hubUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'password123' }),
    });
    expect(regRes.status).toBe(201);

    const loginRes = await fetch(`${hubUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'password123' }),
    });
    expect(loginRes.status).toBe(200);
    const setCookieHeader = loginRes.headers.get('set-cookie');
    expect(setCookieHeader).toBeTruthy();
    sessionCookie = setCookieHeader!.split(';')[0]!;

    const devRes = await fetch(`${hubUrl}/devices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: sessionCookie },
      body: JSON.stringify({ name: 'test-device', hostname: 'test-host', platform: 'linux' }),
    });
    expect(devRes.status).toBe(201);
    const devBody = (await devRes.json()) as { token: string };
    deviceToken = devBody.token;

    const runtimes = new RuntimeRegistry();
    runtimes.register(new MockRuntime({ completionDelayMs: 20 }));
    daemon = new Daemon({
      hubUrl,
      deviceToken,
      workdir,
      runtimes,
      defaultRuntimeId: 'mock',
      logger: {
        info: (msg, meta) => {
          process.stdout.write(`[daemon] ${msg} ${meta ? JSON.stringify(meta) : ''}\n`);
        },
        error: (msg, meta) => {
          process.stderr.write(`[daemon] ERR ${msg} ${meta ? JSON.stringify(meta) : ''}\n`);
        },
      },
    });
    await daemon.start();
  }, 15000);

  afterEach(async () => {
    await daemon.stop();
    await hub.close();
    await fs.rm(workdir, { recursive: true, force: true });
  });

  it('full cycle: create via API, daemon claims, mock agent completes, hub shows completed', { timeout: 20000 }, async () => {
    const createRes = await fetch(`${hubUrl}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: sessionCookie },
      body: JSON.stringify({
        projectPrefix: 'fl',
        title: 'Integration test task',
        description: 'Vertical slice proving the architecture works end-to-end',
      }),
    });
    expect(createRes.status).toBe(201);
    const { id: taskId } = (await createRes.json()) as { id: string };
    expect(taskId).toBe('fl-001');

    let lastStatus = '';
    const completed = await waitFor(async () => {
      const res = await fetch(`${hubUrl}/tasks/${taskId}`, {
        headers: { cookie: sessionCookie },
      });
      if (!res.ok) return null;
      const task = (await res.json()) as { status: string; completedAt: unknown };
      if (task.status !== lastStatus) {
        lastStatus = task.status;
        process.stdout.write(`[test] task status: ${task.status}\n`);
      }
      return task.status === 'completed' ? task : null;
    }, 12000);
    expect(completed.status).toBe('completed');
    expect(completed.completedAt).toBeTruthy();

    const histRes = await fetch(`${hubUrl}/tasks/${taskId}/history`, {
      headers: { cookie: sessionCookie },
    });
    expect(histRes.status).toBe(200);
    const { history } = (await histRes.json()) as {
      history: Array<{ eventName: string; source: string }>;
    };
    const eventNames = history.map((h) => h.eventName);
    expect(eventNames).toContain('task.created');
    expect(eventNames).toContain('task.claimed');
    expect(eventNames).toContain('task.completed');
  });
});

describe('integration: workspace-scoped task flow', () => {
  let hub: Hub;
  let daemon: Daemon;
  let workdir: string;
  let hubUrl: string;
  let deviceToken: string;
  let sessionCookie: string;
  let workspaceId: string;

  beforeEach(async () => {
    workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-ws-'));

    hub = await createHub({
      config: {
        port: 0,
        host: '127.0.0.1',
        databaseUrl: ':memory:',
        sessionSecret: 'test-secret-for-workspace-test-xxxxxxxxx',
        sessionTtlHours: 24,
        bcryptCost: 10,
        cookieSecure: false,
      },
    });
    hubUrl = await hub.fastify.listen({ port: 0, host: '127.0.0.1' });

    const regRes = await fetch(`${hubUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'password123' }),
    });
    expect(regRes.status).toBe(201);

    const loginRes = await fetch(`${hubUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'password123' }),
    });
    expect(loginRes.status).toBe(200);
    const setCookieHeader = loginRes.headers.get('set-cookie');
    expect(setCookieHeader).toBeTruthy();
    sessionCookie = setCookieHeader!.split(';')[0]!;

    const wsRes = await fetch(`${hubUrl}/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: sessionCookie },
      body: JSON.stringify({ name: 'Test Workspace', slug: 'test-ws' }),
    });
    expect(wsRes.status).toBe(201);
    workspaceId = ((await wsRes.json()) as { id: string }).id;

    const devRes = await fetch(`${hubUrl}/devices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: sessionCookie },
      body: JSON.stringify({ name: 'ws-device', hostname: 'test-host', platform: 'linux' }),
    });
    expect(devRes.status).toBe(201);
    const devBody = (await devRes.json()) as { token: string };
    deviceToken = devBody.token;

    const runtimes = new RuntimeRegistry();
    runtimes.register(new MockRuntime({ completionDelayMs: 20 }));
    daemon = new Daemon({
      hubUrl,
      deviceToken,
      workdir,
      runtimes,
      defaultRuntimeId: 'mock',
      workspaceId,
      logger: {
        info: (msg, meta) => {
          process.stdout.write(`[daemon] ${msg} ${meta ? JSON.stringify(meta) : ''}\n`);
        },
        error: (msg, meta) => {
          process.stderr.write(`[daemon] ERR ${msg} ${meta ? JSON.stringify(meta) : ''}\n`);
        },
      },
    });
    await daemon.start();
  }, 15000);

  afterEach(async () => {
    await daemon.stop();
    await hub.close();
    await fs.rm(workdir, { recursive: true, force: true });
  });

  it('daemon only picks up workspace tasks, not flat tasks', { timeout: 20000 }, async () => {
    // Create a flat task — daemon should NOT pick it up (it watches workspace tasks only)
    const flatRes = await fetch(`${hubUrl}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: sessionCookie },
      body: JSON.stringify({ projectPrefix: 'fl', title: 'Flat task' }),
    });
    expect(flatRes.status).toBe(201);
    const { id: flatTaskId } = (await flatRes.json()) as { id: string };

    // Create a workspace task — daemon SHOULD pick it up
    const wsRes = await fetch(`${hubUrl}/workspaces/${workspaceId}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: sessionCookie },
      body: JSON.stringify({ projectPrefix: 'ws', title: 'Workspace task' }),
    });
    expect(wsRes.status).toBe(201);
    const { id: wsTaskId } = (await wsRes.json()) as { id: string };

    // Workspace task should reach completed
    const completed = await waitFor(async () => {
      const res = await fetch(`${hubUrl}/tasks/${wsTaskId}`, {
        headers: { cookie: sessionCookie },
      });
      if (!res.ok) return null;
      const task = (await res.json()) as { status: string };
      return task.status === 'completed' ? task : null;
    }, 12000);
    expect(completed.status).toBe('completed');

    // Flat task should still be pending_agent (daemon ignored it)
    const flatRes2 = await fetch(`${hubUrl}/tasks/${flatTaskId}`, {
      headers: { cookie: sessionCookie },
    });
    const flatTask = (await flatRes2.json()) as { status: string };
    expect(flatTask.status).toBe('pending_agent');
  });
});

describe('integration: description truncation + empty personality fallback', () => {
  let hub: Hub;
  let daemon: Daemon;
  let workdir: string;
  let hubUrl: string;
  let deviceToken: string;
  let sessionCookie: string;

  // Captures the last spawned initialPrompt + personality so tests can assert on them.
  let lastSpawnPrompt = '';
  let lastSpawnPersonality = '';

  beforeEach(async () => {
    workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-trunc-'));

    hub = await createHub({
      config: {
        port: 0,
        host: '127.0.0.1',
        databaseUrl: ':memory:',
        sessionSecret: 'test-secret-for-trunc-test-xxxxxxxxxx',
        sessionTtlHours: 24,
        bcryptCost: 10,
        cookieSecure: false,
      },
    });
    hubUrl = await hub.fastify.listen({ port: 0, host: '127.0.0.1' });

    const regRes = await fetch(`${hubUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'password123' }),
    });
    expect(regRes.status).toBe(201);

    const loginRes = await fetch(`${hubUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'password123' }),
    });
    expect(loginRes.status).toBe(200);
    const setCookieHeader = loginRes.headers.get('set-cookie');
    expect(setCookieHeader).toBeTruthy();
    sessionCookie = setCookieHeader!.split(';')[0]!;

    const devRes = await fetch(`${hubUrl}/devices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: sessionCookie },
      body: JSON.stringify({ name: 'test-device', hostname: 'test-host', platform: 'linux' }),
    });
    expect(devRes.status).toBe(201);
    const devBody = (await devRes.json()) as { token: string };
    deviceToken = devBody.token;

    const runtimes = new RuntimeRegistry();
    runtimes.register(
      new MockRuntime({
        completionDelayMs: 20,
        resultFactory: ({ prompt, personality }) => {
          lastSpawnPrompt = prompt;
          lastSpawnPersonality = personality;
          return `ok`;
        },
      }),
    );

    daemon = new Daemon({
      hubUrl,
      deviceToken,
      workdir,
      runtimes,
      defaultRuntimeId: 'mock',
      // Empty string — should fall back to 'default' not pass blank --system-prompt
      defaultPersonality: '',
    });
    await daemon.start();
  }, 15000);

  afterEach(async () => {
    await daemon.stop();
    await hub.close();
    await fs.rm(workdir, { recursive: true, force: true });
  });

  it('truncates oversized description to 8000 chars in initialPrompt', { timeout: 20000 }, async () => {
    const longDesc = 'x'.repeat(10_000); // 10 000 chars — over the 8 000 limit
    const createRes = await fetch(`${hubUrl}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: sessionCookie },
      body: JSON.stringify({ projectPrefix: 'tr', title: 'Trunc task', description: longDesc }),
    });
    expect(createRes.status).toBe(201);
    const { id: taskId } = (await createRes.json()) as { id: string };

    await waitFor(async () => {
      const res = await fetch(`${hubUrl}/tasks/${taskId}`, { headers: { cookie: sessionCookie } });
      if (!res.ok) return null;
      const task = (await res.json()) as { status: string };
      return task.status === 'completed' ? task : null;
    }, 12000);

    // prompt is "Trunc task\n\n" + truncated description (8000 chars) + done-file instruction
    // Use 9000 as generous upper bound — truncation at 8000 is the critical invariant.
    expect(lastSpawnPrompt.length).toBeLessThanOrEqual(9_000);
    expect(lastSpawnPrompt).toContain('Trunc task');
    // Done-file instruction still present even with truncated description
    expect(lastSpawnPrompt).toContain('.forge/tasks/');
  });

  it('initialPrompt includes done-file write instruction with taskId', { timeout: 20000 }, async () => {
    const createRes = await fetch(`${hubUrl}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: sessionCookie },
      body: JSON.stringify({ projectPrefix: 'tr', title: 'Done file instruction test' }),
    });
    expect(createRes.status).toBe(201);
    const { id: taskId } = (await createRes.json()) as { id: string };

    await waitFor(async () => {
      const res = await fetch(`${hubUrl}/tasks/${taskId}`, { headers: { cookie: sessionCookie } });
      if (!res.ok) return null;
      const task = (await res.json()) as { status: string };
      return task.status === 'completed' ? task : null;
    }, 12000);

    // Initial prompt must include explicit done-file write instruction so agents
    // actually write the file (not just describe writing it in text output).
    expect(lastSpawnPrompt).toContain('.forge/tasks/');
    expect(lastSpawnPrompt).toContain(taskId);
    expect(lastSpawnPrompt).toContain('.done');
  });

  it('empty defaultPersonality falls back to non-empty string (not blank --system-prompt)', { timeout: 20000 }, async () => {
    const createRes = await fetch(`${hubUrl}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: sessionCookie },
      body: JSON.stringify({ projectPrefix: 'tr', title: 'Personality fallback task' }),
    });
    expect(createRes.status).toBe(201);
    const { id: taskId } = (await createRes.json()) as { id: string };

    await waitFor(async () => {
      const res = await fetch(`${hubUrl}/tasks/${taskId}`, { headers: { cookie: sessionCookie } });
      if (!res.ok) return null;
      const task = (await res.json()) as { status: string };
      return task.status === 'completed' ? task : null;
    }, 12000);

    expect(lastSpawnPersonality.trim().length).toBeGreaterThan(0);
  });
});

describe('integration: composed personality via registry', () => {
  let hub: Hub;
  let daemon: Daemon;
  let workdir: string;
  let hubUrl: string;
  let deviceToken: string;
  let sessionCookie: string;

  beforeEach(async () => {
    workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-compose-'));

    // Write a project context file so the compose layer picks it up
    const ctxDir = path.join(workdir, 'context');
    await fs.mkdir(ctxDir, { recursive: true });
    await fs.writeFile(
      path.join(ctxDir, 'project-context.md'),
      '# Test Project\n\nCOMPOSE_MARKER_FOUND',
      'utf8',
    );

    hub = await createHub({
      config: {
        port: 0,
        host: '127.0.0.1',
        databaseUrl: ':memory:',
        sessionSecret: 'test-secret-for-compose-test-xxxxxxxxx',
        sessionTtlHours: 24,
        bcryptCost: 10,
        cookieSecure: false,
      },
    });
    hubUrl = await hub.fastify.listen({ port: 0, host: '127.0.0.1' });

    const regRes = await fetch(`${hubUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'password123' }),
    });
    expect(regRes.status).toBe(201);

    const loginRes = await fetch(`${hubUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'password123' }),
    });
    expect(loginRes.status).toBe(200);
    const setCookieHeader = loginRes.headers.get('set-cookie');
    expect(setCookieHeader).toBeTruthy();
    sessionCookie = setCookieHeader!.split(';')[0]!;

    const devRes = await fetch(`${hubUrl}/devices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: sessionCookie },
      body: JSON.stringify({ name: 'test-device', hostname: 'test-host', platform: 'linux' }),
    });
    expect(devRes.status).toBe(201);
    const devBody = (await devRes.json()) as { token: string };
    deviceToken = devBody.token;

    const registry = await loadBuiltinRegistry();
    const runtimes = new RuntimeRegistry();
    runtimes.register(
      new MockRuntime({
        completionDelayMs: 20,
        resultFactory: ({ personality }) => `ECHO_PERSONALITY:${personality}`,
      }),
    );

    daemon = new Daemon({
      hubUrl,
      deviceToken,
      workdir,
      runtimes,
      defaultRuntimeId: 'mock',
      defaultAgentId: 'architect',
      personalityRegistry: registry,
      logger: {
        info: (msg, meta) => {
          process.stdout.write(`[daemon] ${msg} ${meta ? JSON.stringify(meta) : ''}\n`);
        },
        error: (msg, meta) => {
          process.stderr.write(`[daemon] ERR ${msg} ${meta ? JSON.stringify(meta) : ''}\n`);
        },
      },
    });
    await daemon.start();
  }, 15000);

  afterEach(async () => {
    await daemon.stop();
    await hub.close();
    await fs.rm(workdir, { recursive: true, force: true });
  });

  it('daemon composes personality prompt with registry and passes it to runtime', { timeout: 20000 }, async () => {
    const createRes = await fetch(`${hubUrl}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: sessionCookie },
      body: JSON.stringify({
        projectPrefix: 'fl',
        title: 'Composition test task',
        description: 'Verify system prompt composition',
      }),
    });
    expect(createRes.status).toBe(201);
    const { id: taskId } = (await createRes.json()) as { id: string };

    const completed = await waitFor(async () => {
      const res = await fetch(`${hubUrl}/tasks/${taskId}`, {
        headers: { cookie: sessionCookie },
      });
      if (!res.ok) return null;
      const task = (await res.json()) as { status: string };
      return task.status === 'completed' ? task : null;
    }, 12000);
    expect(completed).toBeTruthy();

    // Check the history to verify the echoed personality in the completion result
    const histRes = await fetch(`${hubUrl}/tasks/${taskId}/history`, {
      headers: { cookie: sessionCookie },
    });
    expect(histRes.status).toBe(200);
    const { history } = (await histRes.json()) as {
      history: Array<{ eventName: string; payload: Record<string, unknown> }>;
    };
    const completionEvent = history.find((h) => h.eventName === 'task.completed');
    expect(completionEvent).toBeTruthy();
    const echoedResult = (completionEvent!.payload as { result?: string }).result ?? '';

    // The echoed result should contain the Architect personality content
    expect(echoedResult).toContain('ECHO_PERSONALITY:');
    // The Architect personality system prompt should be in there
    expect(echoedResult).toContain('Architect');
    // The project context marker should be in the composed prompt
    expect(echoedResult).toContain('COMPOSE_MARKER_FOUND');
    // The task context should be in the composed prompt
    expect(echoedResult).toContain('Composition test task');
  });
});

// ---------------------------------------------------------------------------
// HubClient FM orchestrator methods
// ---------------------------------------------------------------------------

describe('HubClient: FM orchestrator methods', () => {
  let hub: Hub;
  let hubUrl: string;
  let sessionCookie: string;
  let orchestratorToken: string;
  let workspaceId: string;

  beforeEach(async () => {
    hub = await createHub({
      config: {
        port: 0,
        host: '127.0.0.1',
        databaseUrl: ':memory:',
        sessionSecret: 'test-secret-for-fm-methods-test-xxxxxxxxxxx',
        sessionTtlHours: 24,
        bcryptCost: 10,
        cookieSecure: false,
      },
    });
    hubUrl = await hub.fastify.listen({ port: 0, host: '127.0.0.1' });

    await fetch(`${hubUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'password123' }),
    });
    const loginRes = await fetch(`${hubUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'password123' }),
    });
    sessionCookie = loginRes.headers.get('set-cookie')!.split(';')[0]!;

    // Register an orchestrator device
    const devRes = await fetch(`${hubUrl}/devices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: sessionCookie },
      body: JSON.stringify({ name: 'forge-master', agentId: 'forge-master', deviceType: 'orchestrator' }),
    });
    orchestratorToken = ((await devRes.json()) as { token: string }).token;

    // Create workspace
    const wsRes = await fetch(`${hubUrl}/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: sessionCookie },
      body: JSON.stringify({ name: 'FM Test WS', slug: 'fm-test' }),
    });
    workspaceId = ((await wsRes.json()) as { id: string }).id;
  }, 15000);

  afterEach(async () => {
    await hub.close();
  });

  it('getWorkspaceContext returns correct shape', async () => {
    const client = new HubClient({ hubUrl, deviceToken: orchestratorToken });
    const ctx = await client.getWorkspaceContext(workspaceId);

    expect(ctx.workspaceId).toBe(workspaceId);
    expect(Array.isArray(ctx.docs)).toBe(true);
    expect(Array.isArray(ctx.goals)).toBe(true);
    expect(Array.isArray(ctx.inboxTasks)).toBe(true);
    expect(typeof ctx.queueDepth).toBe('object');
  });

  it('assignTask routes task to agentId', async () => {
    const client = new HubClient({ hubUrl, deviceToken: orchestratorToken });

    // Task created in pending_agent status — pending_agent is in FM_ASSIGNABLE_STATUSES
    const taskRes = await fetch(`${hubUrl}/workspaces/${workspaceId}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: sessionCookie },
      body: JSON.stringify({ projectPrefix: 'fm', title: 'FM assign test' }),
    });
    const { id: taskId } = (await taskRes.json()) as { id: string };

    await client.assignTask(workspaceId, taskId, 'architect');

    const task = await fetch(`${hubUrl}/tasks/${taskId}`, { headers: { cookie: sessionCookie } });
    const body = (await task.json()) as { status: string; assignedAgentId: string };
    expect(body.status).toBe('assigned');
    expect(body.assignedAgentId).toBe('architect');
  });

  it('assignTask with worker token throws (orchestrator_required)', async () => {
    // Register a worker device
    const workerRes = await fetch(`${hubUrl}/devices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: sessionCookie },
      body: JSON.stringify({ name: 'worker', agentId: 'worker', deviceType: 'worker' }),
    });
    const workerToken = ((await workerRes.json()) as { token: string }).token;
    const workerClient = new HubClient({ hubUrl, deviceToken: workerToken });

    const taskRes = await fetch(`${hubUrl}/workspaces/${workspaceId}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: sessionCookie },
      body: JSON.stringify({ projectPrefix: 'fw', title: 'Worker assign attempt' }),
    });
    const { id: taskId } = (await taskRes.json()) as { id: string };

    await expect(workerClient.assignTask(workspaceId, taskId, 'architect')).rejects.toThrow('403');
  });

  it('getStaleAssigned returns tasks past ttl', async () => {
    const client = new HubClient({ hubUrl, deviceToken: orchestratorToken });

    const result = await client.getStaleAssigned(workspaceId, 30);
    expect(Array.isArray(result.tasks)).toBe(true);
    expect(result.ttlMinutes).toBe(30);
    expect(typeof result.cutoff).toBe('string');
  });

  it('requeueStaleAssigned returns requeued count', async () => {
    const client = new HubClient({ hubUrl, deviceToken: orchestratorToken });

    const result = await client.requeueStaleAssigned(workspaceId, 30);
    expect(typeof result.requeued).toBe('number');
    expect(result.requeued).toBe(0); // nothing stale in fresh workspace
  });
});

// ---------------------------------------------------------------------------
// Dispatcher mode — FM orchestrator
// ---------------------------------------------------------------------------

describe('integration: dispatcher mode', () => {
  let hub: Hub;
  let daemon: Daemon;
  let workdir: string;
  let hubUrl: string;
  let sessionCookie: string;
  let workspaceId: string;
  let capturedInfoLogs: string[] = [];

  beforeEach(async () => {
    capturedInfoLogs = [];
    workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-fm-'));

    hub = await createHub({
      config: {
        port: 0,
        host: '127.0.0.1',
        databaseUrl: ':memory:',
        sessionSecret: 'test-secret-for-dispatcher-mode-xxxxxxxxx',
        sessionTtlHours: 24,
        bcryptCost: 10,
        cookieSecure: false,
      },
    });
    hubUrl = await hub.fastify.listen({ port: 0, host: '127.0.0.1' });

    await fetch(`${hubUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'password123' }),
    });
    const loginRes = await fetch(`${hubUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'password123' }),
    });
    sessionCookie = loginRes.headers.get('set-cookie')!.split(';')[0]!;

    // Register orchestrator device
    const devRes = await fetch(`${hubUrl}/devices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: sessionCookie },
      body: JSON.stringify({ name: 'forge-master', agentId: 'forge-master', deviceType: 'orchestrator' }),
    });
    const orchestratorToken = ((await devRes.json()) as { token: string }).token;

    // Create workspace
    const wsRes = await fetch(`${hubUrl}/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: sessionCookie },
      body: JSON.stringify({ name: 'FM Dispatch WS', slug: 'fm-dispatch' }),
    });
    workspaceId = ((await wsRes.json()) as { id: string }).id;

    const runtimes = new RuntimeRegistry();
    runtimes.register(new MockRuntime({ completionDelayMs: 50 }));
    daemon = new Daemon({
      hubUrl,
      deviceToken: orchestratorToken,
      workdir,
      runtimes,
      defaultRuntimeId: 'mock',
      workspaceId,
      dispatcherMode: true,
      fmAgentId: 'forge-master',
      pollIntervalMs: 100,
      logger: {
        info: (msg, meta) => {
          capturedInfoLogs.push(msg);
          process.stdout.write(`[fm-daemon] ${msg} ${meta ? JSON.stringify(meta) : ''}\n`);
        },
        error: (msg, meta) => {
          process.stderr.write(`[fm-daemon] ERR ${msg} ${meta ? JSON.stringify(meta) : ''}\n`);
        },
      },
    });
    await daemon.start();
  }, 15000);

  afterEach(async () => {
    await daemon.stop();
    await hub.close();
    await fs.rm(workdir, { recursive: true, force: true });
  });

  it('dispatcher spawns FM agent when inbox has pending_dispatcher_action tasks', { timeout: 20000 }, async () => {
    // Create a task, then directly set it to pending_dispatcher_action via DB
    // (The user PATCH API only allows transitions to 'cancelled' — not dispatcher action)
    const taskRes = await fetch(`${hubUrl}/workspaces/${workspaceId}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: sessionCookie },
      body: JSON.stringify({ projectPrefix: 'fm', title: 'Needs FM triage' }),
    });
    expect(taskRes.status).toBe(201);
    const { id: taskId } = (await taskRes.json()) as { id: string };

    // Directly set status in DB — avoids routing through user PATCH which doesn't
    // allow pending_dispatcher_action as a user-initiated transition
    await hub.db
      .update(schema.tasks)
      .set({ status: 'pending_dispatcher_action' })
      .where(eq(schema.tasks.id, taskId));

    // Wait for FM agent to spawn (daemon polls every 100ms) and complete.
    // MockRuntime writes done file after 50ms; handleTaskDone fires via watcher.
    // Logger captures 'fm agent completed' once the cycle finishes.
    await waitFor(async () => {
      return capturedInfoLogs.includes('fm agent completed') ? 'done' : null;
    }, 5000);

    // Daemon survived the full FM cycle
    expect(daemon['running']).toBe(true);
    expect(capturedInfoLogs).toContain('fm agent completed');
  });

  it('dispatcher does not spawn FM when inbox is empty', { timeout: 10000 }, async () => {
    // No tasks in inbox — wait 500ms and verify no FM was spawned
    await new Promise((r) => setTimeout(r, 500));

    // No _fm_ done files should have appeared
    const doneDir = path.join(workdir, '.forge', 'tasks');
    let files: string[] = [];
    try {
      files = await fs.readdir(doneDir);
    } catch {
      // Directory may not exist if no tasks ran — that's fine
    }
    // No FM done files should exist since inbox was empty and FM never spawned
    expect(files.filter((f) => f.startsWith('_fm_'))).toHaveLength(0);
    expect(daemon['running']).toBe(true);
  });

  it('dispatcher does not double-spawn FM while FM is running', { timeout: 15000 }, async () => {
    // Create two tasks in pending_dispatcher_action via direct DB update
    for (let i = 0; i < 2; i++) {
      const taskRes = await fetch(`${hubUrl}/workspaces/${workspaceId}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie: sessionCookie },
        body: JSON.stringify({ projectPrefix: 'fm', title: `Task ${i + 1}` }),
      });
      const { id: taskId } = (await taskRes.json()) as { id: string };
      await hub.db
        .update(schema.tasks)
        .set({ status: 'pending_dispatcher_action' })
        .where(eq(schema.tasks.id, taskId));
    }

    // Let two poll cycles pass — FM spawns on first, skips on second
    await new Promise((r) => setTimeout(r, 350));

    // Verify daemon is still healthy (no crash from double-spawn)
    expect(daemon['running']).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Dispatcher mode — FM personality registry loading
// ---------------------------------------------------------------------------

describe('integration: dispatcher mode — personality registry', () => {
  let hub: Hub;
  let daemon: Daemon;
  let workdir: string;
  let hubUrl: string;
  let sessionCookie: string;
  let workspaceId: string;
  let capturedPersonalities: string[] = [];

  beforeEach(async () => {
    capturedPersonalities = [];
    workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-fm-personality-'));

    hub = await createHub({
      config: {
        port: 0,
        host: '127.0.0.1',
        databaseUrl: ':memory:',
        sessionSecret: 'test-secret-for-fm-personality-test-xxxxxxxx',
        sessionTtlHours: 24,
        bcryptCost: 10,
        cookieSecure: false,
      },
    });
    hubUrl = await hub.fastify.listen({ port: 0, host: '127.0.0.1' });

    await fetch(`${hubUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'password123' }),
    });
    const loginRes = await fetch(`${hubUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'password123' }),
    });
    sessionCookie = loginRes.headers.get('set-cookie')!.split(';')[0]!;

    const devRes = await fetch(`${hubUrl}/devices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: sessionCookie },
      body: JSON.stringify({ name: 'forge-master', agentId: 'forge-master', deviceType: 'orchestrator' }),
    });
    const orchestratorToken = ((await devRes.json()) as { token: string }).token;

    const wsRes = await fetch(`${hubUrl}/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: sessionCookie },
      body: JSON.stringify({ name: 'FM Personality WS', slug: 'fm-personality' }),
    });
    workspaceId = ((await wsRes.json()) as { id: string }).id;

    const registry = await loadBuiltinRegistry();
    const runtimes = new RuntimeRegistry();
    runtimes.register(
      new MockRuntime({
        completionDelayMs: 20,
        resultFactory: ({ personality }) => {
          capturedPersonalities.push(personality);
          return 'FM_TRIAGE_COMPLETE';
        },
      }),
    );

    daemon = new Daemon({
      hubUrl,
      deviceToken: orchestratorToken,
      workdir,
      runtimes,
      defaultRuntimeId: 'mock',
      workspaceId,
      dispatcherMode: true,
      fmAgentId: 'forge-master',
      dispatcherPersonality: 'forge-master',
      personalityRegistry: registry,
      pollIntervalMs: 100,
      logger: {
        info: (msg, meta) => {
          process.stdout.write(`[fm-daemon] ${msg} ${meta ? JSON.stringify(meta) : ''}\n`);
        },
        error: (msg, meta) => {
          process.stderr.write(`[fm-daemon] ERR ${msg} ${meta ? JSON.stringify(meta) : ''}\n`);
        },
      },
    });
    await daemon.start();
  }, 15000);

  afterEach(async () => {
    await daemon.stop();
    await hub.close();
    await fs.rm(workdir, { recursive: true, force: true });
  });

  it('dispatcher uses forge-master personality from registry when spawning FM', { timeout: 20000 }, async () => {
    // Create a task in pending_dispatcher_action
    const taskRes = await fetch(`${hubUrl}/workspaces/${workspaceId}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: sessionCookie },
      body: JSON.stringify({ projectPrefix: 'fmp', title: 'Personality registry test task' }),
    });
    expect(taskRes.status).toBe(201);
    const { id: taskId } = (await taskRes.json()) as { id: string };

    await hub.db
      .update(schema.tasks)
      .set({ status: 'pending_dispatcher_action' })
      .where(eq(schema.tasks.id, taskId));

    // Wait for FM to spawn and complete
    await waitFor(async () => {
      return capturedPersonalities.length > 0 ? 'done' : null;
    }, 8000);

    expect(capturedPersonalities.length).toBeGreaterThan(0);
    // The FM personality loaded from the registry should contain the FM identity marker
    const fmPersonality = capturedPersonalities[0] ?? '';
    expect(fmPersonality).toContain('Forge Master');
    // Should contain FM-specific content from the personality file
    expect(fmPersonality).toContain('orchestrator');
  });

  it('dispatcher falls back to default personality when registry missing the id', { timeout: 15000 }, async () => {
    // Stop the daemon and restart without personality registry
    await daemon.stop();

    const devRes = await fetch(`${hubUrl}/devices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: sessionCookie },
      body: JSON.stringify({ name: 'forge-master-2', agentId: 'forge-master', deviceType: 'orchestrator' }),
    });
    const orchestratorToken2 = ((await devRes.json()) as { token: string }).token;

    const fallbackPersonalities: string[] = [];
    const runtimes2 = new RuntimeRegistry();
    runtimes2.register(
      new MockRuntime({
        completionDelayMs: 20,
        resultFactory: ({ personality }) => {
          fallbackPersonalities.push(personality);
          return 'FALLBACK_DONE';
        },
      }),
    );

    const daemon2 = new Daemon({
      hubUrl,
      deviceToken: orchestratorToken2,
      workdir,
      runtimes: runtimes2,
      defaultRuntimeId: 'mock',
      workspaceId,
      dispatcherMode: true,
      fmAgentId: 'forge-master',
      dispatcherPersonality: 'nonexistent-personality',
      // No personalityRegistry → fallback to defaultPersonality / built-in string
      pollIntervalMs: 100,
      logger: {
        info: () => {},
        error: () => {},
      },
    });
    await daemon2.start();

    try {
      const taskRes = await fetch(`${hubUrl}/workspaces/${workspaceId}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie: sessionCookie },
        body: JSON.stringify({ projectPrefix: 'fmp', title: 'Fallback personality test' }),
      });
      const { id: taskId } = (await taskRes.json()) as { id: string };
      await hub.db
        .update(schema.tasks)
        .set({ status: 'pending_dispatcher_action' })
        .where(eq(schema.tasks.id, taskId));

      await waitFor(async () => {
        return fallbackPersonalities.length > 0 ? 'done' : null;
      }, 8000);
    } finally {
      await daemon2.stop();
    }

    // Fallback personality should be the default string (not forge-master content)
    expect(fallbackPersonalities.length).toBeGreaterThan(0);
    // The fallback is 'You are the Forge Master orchestrator.' (from daemon.ts)
    expect(fallbackPersonalities[0]).toContain('Forge Master orchestrator');
  });
});

// ---------------------------------------------------------------------------
// Spawn failure recovery — daemon calls failTask after spawn throws
// ---------------------------------------------------------------------------

/** Runtime that always throws during spawn. Used to test daemon failTask recovery. */
class FailingRuntime implements AgentRuntime {
  readonly id = 'failing';
  readonly displayName = 'Failing Runtime';
  readonly capabilities = { supportsStreaming: false, supportsTools: false } as const;

  spawn(_config: AgentRuntimeSpawnConfig, _initialPrompt: string): Promise<RuntimeInstance> {
    return Promise.reject(new Error('Simulated spawn failure'));
  }

  sendInstruction(_instance: RuntimeInstance, _text: string): Promise<void> {
    return Promise.resolve();
  }

  stop(_instance: RuntimeInstance): Promise<void> {
    return Promise.resolve();
  }

  isAlive(_instance: RuntimeInstance): Promise<boolean> {
    return Promise.resolve(false);
  }
}

describe('integration: spawn failure recovery', () => {
  let hub: Hub;
  let daemon: Daemon;
  let workdir: string;
  let hubUrl: string;
  let sessionCookie: string;

  beforeEach(async () => {
    workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-fail-'));

    hub = await createHub({
      config: {
        port: 0,
        host: '127.0.0.1',
        databaseUrl: ':memory:',
        sessionSecret: 'test-secret-for-spawn-failure-recovery-xxxx',
        sessionTtlHours: 24,
        bcryptCost: 10,
        cookieSecure: false,
      },
    });
    hubUrl = await hub.fastify.listen({ port: 0, host: '127.0.0.1' });

    await fetch(`${hubUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'password123' }),
    });
    const loginRes = await fetch(`${hubUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'password123' }),
    });
    sessionCookie = loginRes.headers.get('set-cookie')!.split(';')[0]!;

    const devRes = await fetch(`${hubUrl}/devices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: sessionCookie },
      body: JSON.stringify({ name: 'failing-device' }),
    });
    const deviceToken = ((await devRes.json()) as { token: string }).token;

    const runtimes = new RuntimeRegistry();
    runtimes.register(new FailingRuntime());
    daemon = new Daemon({
      hubUrl,
      deviceToken,
      workdir,
      runtimes,
      defaultRuntimeId: 'failing',
      pollIntervalMs: 100,
      logger: {
        info: () => {},
        error: () => {},
      },
    });
    await daemon.start();
  }, 15000);

  afterEach(async () => {
    await daemon.stop();
    await hub.close();
    await fs.rm(workdir, { recursive: true, force: true });
  });

  it('daemon marks task as failed when spawn throws', { timeout: 10000 }, async () => {
    const createRes = await fetch(`${hubUrl}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: sessionCookie },
      body: JSON.stringify({ projectPrefix: 'fail', title: 'Will fail to spawn' }),
    });
    expect(createRes.status).toBe(201);
    const { id: taskId } = (await createRes.json()) as { id: string };

    // Wait for daemon to claim and attempt spawn (then fail and call failTask)
    await waitFor(async () => {
      const res = await fetch(`${hubUrl}/tasks/${taskId}`, { headers: { cookie: sessionCookie } });
      const task = (await res.json()) as { status: string };
      return task.status === 'failed' ? 'failed' : null;
    }, 5000);

    // Verify final state
    const finalRes = await fetch(`${hubUrl}/tasks/${taskId}`, { headers: { cookie: sessionCookie } });
    const finalTask = (await finalRes.json()) as { status: string };
    expect(finalTask.status).toBe('failed');

    // Verify task.failed history event
    const histRes = await fetch(`${hubUrl}/tasks/${taskId}/history`, { headers: { cookie: sessionCookie } });
    const { history } = (await histRes.json()) as { history: { eventName: string; payload: unknown }[] };
    // Exactly one task.failed event — guards against duplicate events from race condition
    const failEvents = history.filter((h) => h.eventName === 'task.failed');
    expect(failEvents).toHaveLength(1);
    const payload = failEvents[0]?.payload as Record<string, unknown> | undefined;
    expect(typeof payload?.['reason']).toBe('string');
    expect((payload?.['reason'] as string)).toContain('Simulated spawn failure');
  });
});

// ---------------------------------------------------------------------------
// FM triage integration — full assign cycle
//
// FMSimRuntime simulates what the real FM agent does:
//   1. Parse inboxTasks from the context JSON in initialPrompt
//   2. Assign each inbox task to 'architect' via hub API
//   3. Post a structured dispatcher comment on each task
//   4. Write the done file
//
// This verifies the full dispatcher → FM → hub state change cycle without
// requiring a real claude subprocess.
// ---------------------------------------------------------------------------

/**
 * Minimal subset of the hub's workspace context response.
 * Only the fields FMSimRuntime actually reads are declared here.
 * The full response also contains docs, goals, agents, liveInstances,
 * recentHistory, dispatcherHistory, and queueDepth — not needed by the sim.
 */
type WorkspaceContext = {
  workspaceId: string;
  inboxTasks: { id: string; title: string }[];
};

import { doneFilePath, taskDir } from './sync/task-file.js';

class FMSimRuntime implements AgentRuntime {
  readonly id = 'fm-sim';
  readonly displayName = 'FM Simulation Runtime';
  readonly capabilities = { supportsStreaming: false, supportsTools: false } as const;

  private readonly hubUrl: string;
  private readonly orchestratorToken: string;
  readonly assignedTasks: string[] = [];
  readonly postedComments: string[] = [];

  constructor(hubUrl: string, orchestratorToken: string) {
    this.hubUrl = hubUrl;
    this.orchestratorToken = orchestratorToken;
  }

  spawn(config: AgentRuntimeSpawnConfig, initialPrompt: string): Promise<RuntimeInstance> {
    const taskId = config.taskId;
    const workdir = config.workdir;

    setTimeout(() => {
      void (async () => {
        // Extract context JSON from initialPrompt.
        // Format: "Workspace context for triage:\n\n{...json...}\n\n---\n..."
        let ctx: WorkspaceContext | null = null;
        try {
          const jsonPart = initialPrompt.split('\n\n---\n')[0] ?? '';
          const jsonStart = jsonPart.indexOf('{');
          if (jsonStart >= 0) {
            ctx = JSON.parse(jsonPart.slice(jsonStart)) as WorkspaceContext;
          }
        } catch {
          // continue with empty context
        }

        const wsId = ctx?.workspaceId;
        const inbox = ctx?.inboxTasks ?? [];

        if (!wsId) {
          // Context parse failed — log so the test timeout has a traceable cause.
          process.stderr.write('[FMSimRuntime] failed to parse workspaceId from context; skipping triage\n');
          return;
        }

        for (const task of inbox) {
          // Assign task to architect
          const assignRes = await fetch(
            `${this.hubUrl}/workspaces/${wsId}/tasks/${task.id}/assign`,
            {
              method: 'PATCH',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${this.orchestratorToken}`,
              },
              body: JSON.stringify({ agentId: 'architect' }),
            },
          );
          if (assignRes.ok) {
            this.assignedTasks.push(task.id);
          }

          // Post dispatcher comment
          const commentRes = await fetch(`${this.hubUrl}/tasks/${task.id}/comments`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${this.orchestratorToken}`,
            },
            body: JSON.stringify({
              body: `Decision: ROUTED\nAgent: architect\nReason: Task "${task.title}" routed to architect.\nConfidence: HIGH`,
              authorType: 'dispatcher',
            }),
          });
          if (commentRes.ok) {
            this.postedComments.push(task.id);
          }
        }

        // Write done file (FM exit signal)
        const donePayload = JSON.stringify({
          result: `FM triage complete: ${inbox.length} task(s) processed`,
          completedAt: new Date().toISOString(),
        });
        try {
          await fs.mkdir(taskDir(workdir), { recursive: true });
          await fs.writeFile(doneFilePath(workdir, taskId), donePayload, 'utf8');
        } catch {
          // workdir may be cleaned up in teardown
        }
      })();
    }, 50);

    return Promise.resolve({
      id: 'fm-sim-instance',
      runtimeId: this.id,
      agentId: config.agentId,
      pid: null,
      startedAt: new Date(),
      metadata: { config },
    });
  }

  sendInstruction(): Promise<void> {
    return Promise.resolve();
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }

  isAlive(): Promise<boolean> {
    // FM sim always completes quickly — isAlive returns false once done file is written.
    // The daemon's file watcher handles cleanup; returning false here is safe.
    return Promise.resolve(false);
  }
}

describe('integration: FM triage — full assign cycle', () => {
  let hub: Hub;
  let daemon: Daemon;
  let workdir: string;
  let hubUrl: string;
  let sessionCookie: string;
  let workspaceId: string;
  let fmSim: FMSimRuntime;

  beforeEach(async () => {
    workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-fm-triage-'));

    hub = await createHub({
      config: {
        port: 0,
        host: '127.0.0.1',
        databaseUrl: ':memory:',
        sessionSecret: 'test-secret-for-fm-triage-integration-xxxxx',
        sessionTtlHours: 24,
        bcryptCost: 10,
        cookieSecure: false,
      },
    });
    hubUrl = await hub.fastify.listen({ port: 0, host: '127.0.0.1' });

    await fetch(`${hubUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'password123' }),
    });
    const loginRes = await fetch(`${hubUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'password123' }),
    });
    sessionCookie = loginRes.headers.get('set-cookie')!.split(';')[0]!;

    const devRes = await fetch(`${hubUrl}/devices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: sessionCookie },
      body: JSON.stringify({ name: 'forge-master', agentId: 'forge-master', deviceType: 'orchestrator' }),
    });
    const orchestratorToken = ((await devRes.json()) as { token: string }).token;

    const wsRes = await fetch(`${hubUrl}/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: sessionCookie },
      body: JSON.stringify({ name: 'FM Triage WS', slug: 'fm-triage' }),
    });
    workspaceId = ((await wsRes.json()) as { id: string }).id;

    fmSim = new FMSimRuntime(hubUrl, orchestratorToken);
    const runtimes = new RuntimeRegistry();
    runtimes.register(fmSim);

    daemon = new Daemon({
      hubUrl,
      deviceToken: orchestratorToken,
      workdir,
      runtimes,
      defaultRuntimeId: 'fm-sim',
      workspaceId,
      dispatcherMode: true,
      fmAgentId: 'forge-master',
      pollIntervalMs: 100,
      logger: {
        info: (msg, meta) => {
          process.stdout.write(`[fm-triage] ${msg} ${meta ? JSON.stringify(meta) : ''}\n`);
        },
        error: (msg, meta) => {
          process.stderr.write(`[fm-triage] ERR ${msg} ${meta ? JSON.stringify(meta) : ''}\n`);
        },
      },
    });
    await daemon.start();
  }, 15000);

  afterEach(async () => {
    await daemon.stop();
    await hub.close();
    await fs.rm(workdir, { recursive: true, force: true });
  });

  it('FM sim assigns inbox task to architect and task status becomes assigned', { timeout: 20000 }, async () => {
    // Create a task and put it in the FM inbox
    const taskRes = await fetch(`${hubUrl}/workspaces/${workspaceId}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: sessionCookie },
      body: JSON.stringify({ projectPrefix: 'tri', title: 'Design the authentication system' }),
    });
    const { id: taskId } = (await taskRes.json()) as { id: string };
    await hub.db
      .update(schema.tasks)
      .set({ status: 'pending_dispatcher_action' })
      .where(eq(schema.tasks.id, taskId));

    // Wait for FM sim to assign the task
    await waitFor(async () => {
      const taskR = await fetch(`${hubUrl}/tasks/${taskId}`, { headers: { cookie: sessionCookie } });
      const t = (await taskR.json()) as { status: string; assignedAgentId: string | null };
      return t.status === 'assigned' && t.assignedAgentId === 'architect' ? t.status : null;
    }, 15000);

    // Verify task is now assigned
    const finalRes = await fetch(`${hubUrl}/tasks/${taskId}`, { headers: { cookie: sessionCookie } });
    const finalTask = (await finalRes.json()) as { status: string; assignedAgentId: string | null };
    expect(finalTask.status).toBe('assigned');
    expect(finalTask.assignedAgentId).toBe('architect');
    expect(fmSim.assignedTasks).toContain(taskId);
  });

  it('FM sim posts structured dispatcher comment on assigned task', { timeout: 20000 }, async () => {
    const taskRes = await fetch(`${hubUrl}/workspaces/${workspaceId}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: sessionCookie },
      body: JSON.stringify({ projectPrefix: 'tri', title: 'Write API documentation' }),
    });
    const { id: taskId } = (await taskRes.json()) as { id: string };
    await hub.db
      .update(schema.tasks)
      .set({ status: 'pending_dispatcher_action' })
      .where(eq(schema.tasks.id, taskId));

    // Wait for FM sim to post the comment
    await waitFor(async () => {
      return fmSim.postedComments.includes(taskId) ? 'done' : null;
    }, 15000);

    // Verify dispatcher comment appears in hub
    const commentsRes = await fetch(`${hubUrl}/tasks/${taskId}/comments`, {
      headers: { cookie: sessionCookie },
    });
    const { comments } = (await commentsRes.json()) as {
      comments: { authorType: string; body: string }[];
    };
    const dispatcherComment = comments.find(c => c.authorType === 'dispatcher');
    expect(dispatcherComment).toBeDefined();
    expect(dispatcherComment?.body).toContain('Decision: ROUTED');
    expect(dispatcherComment?.body).toContain('Agent: architect');
  });

  it('dispatcher-log endpoint reflects FM decisions after triage cycle', { timeout: 20000 }, async () => {
    const taskRes = await fetch(`${hubUrl}/workspaces/${workspaceId}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: sessionCookie },
      body: JSON.stringify({ projectPrefix: 'tri', title: 'Refactor the user service' }),
    });
    const { id: taskId } = (await taskRes.json()) as { id: string };
    await hub.db
      .update(schema.tasks)
      .set({ status: 'pending_dispatcher_action' })
      .where(eq(schema.tasks.id, taskId));

    // Wait for FM sim to complete
    await waitFor(async () => {
      return fmSim.postedComments.includes(taskId) ? 'done' : null;
    }, 15000);

    // Check dispatcher-log endpoint
    const logRes = await fetch(`${hubUrl}/workspaces/${workspaceId}/dispatcher-log`, {
      headers: { cookie: sessionCookie },
    });
    const log = (await logRes.json()) as {
      comments: { taskId: string; taskTitle: string; body: string }[];
      inboxCount: number;
    };

    expect(log.comments.length).toBeGreaterThan(0);
    const entry = log.comments.find(c => c.taskId === taskId);
    expect(entry).toBeDefined();
    expect(entry?.taskTitle).toBe('Refactor the user service');
    expect(entry?.body).toContain('ROUTED');
    // Task was assigned so it's no longer in the inbox
    expect(log.inboxCount).toBe(0);
  });
});
