import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHub, type Hub } from '@forge-lab/hub';
import { loadBuiltinRegistry } from '@forge-lab/agents';
import { Daemon } from './daemon.js';
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
    const { HubClient } = await import('./hub-client.js');
    const client = new HubClient({ hubUrl, deviceToken: orchestratorToken });
    const ctx = await client.getWorkspaceContext(workspaceId);

    expect(ctx.workspaceId).toBe(workspaceId);
    expect(Array.isArray(ctx.docs)).toBe(true);
    expect(Array.isArray(ctx.goals)).toBe(true);
    expect(Array.isArray(ctx.inboxTasks)).toBe(true);
    expect(typeof ctx.queueDepth).toBe('object');
  });

  it('assignTask routes task to agentId', async () => {
    const { HubClient } = await import('./hub-client.js');
    const client = new HubClient({ hubUrl, deviceToken: orchestratorToken });

    // Create a task in pending_dispatcher_action status
    const taskRes = await fetch(`${hubUrl}/workspaces/${workspaceId}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: sessionCookie },
      body: JSON.stringify({ projectPrefix: 'fm', title: 'FM assign test' }),
    });
    const { id: taskId } = (await taskRes.json()) as { id: string };

    // Manually set to pending_dispatcher_action via hub DB isn't possible through API,
    // but pending_agent is assignable too per FM_ASSIGNABLE_STATUSES.
    await client.assignTask(workspaceId, taskId, 'architect');

    // Verify task is now assigned
    const task = await fetch(`${hubUrl}/tasks/${taskId}`, { headers: { cookie: sessionCookie } });
    const body = (await task.json()) as { status: string; assignedAgentId: string };
    expect(body.status).toBe('assigned');
    expect(body.assignedAgentId).toBe('architect');
  });

  it('getStaleAssigned returns tasks past ttl', async () => {
    const { HubClient } = await import('./hub-client.js');
    const client = new HubClient({ hubUrl, deviceToken: orchestratorToken });

    const result = await client.getStaleAssigned(workspaceId, 30);
    expect(Array.isArray(result.tasks)).toBe(true);
    expect(result.ttlMinutes).toBe(30);
    expect(typeof result.cutoff).toBe('string');
  });

  it('requeueStaleAssigned returns requeued count', async () => {
    const { HubClient } = await import('./hub-client.js');
    const client = new HubClient({ hubUrl, deviceToken: orchestratorToken });

    const result = await client.requeueStaleAssigned(workspaceId, 30);
    expect(typeof result.requeued).toBe('number');
    expect(result.requeued).toBe(0); // nothing stale in fresh workspace
  });
});
