import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHub, type Hub } from '@forge-lab/hub';
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
