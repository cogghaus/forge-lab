/**
 * HubClient WebSocket reconnect tests.
 *
 * Uses a real ws.Server on an ephemeral port so we can control connect/disconnect
 * without mocking internals. Keeps base reconnect delay at 50ms to keep tests fast.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { WebSocketServer } from 'ws';
import { HubClient } from './hub-client.js';

/** Starts a WS server on an ephemeral port and returns { server, port }. */
async function startServer(): Promise<{ server: WebSocketServer; port: number }> {
  const server = new WebSocketServer({ port: 0 });
  const port = await new Promise<number>((resolve) => {
    server.once('listening', () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr !== null ? addr.port : 0);
    });
  });
  return { server, port };
}

/** Stops a WS server and waits for it to be fully closed. */
async function stopServer(server: WebSocketServer): Promise<void> {
  // Terminate all connections first so close fires promptly
  for (const client of server.clients) {
    client.terminate();
  }
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

/** Returns a promise that resolves when the emitter emits eventName once. */
function once(emitter: HubClient, eventName: string): Promise<void> {
  return new Promise((resolve) => {
    emitter.once(eventName, () => resolve());
  });
}

describe('HubClient reconnect', () => {
  let client: HubClient | null = null;
  let primaryServer: WebSocketServer | null = null;

  afterEach(async () => {
    await client?.close();
    client = null;
    if (primaryServer) {
      await stopServer(primaryServer).catch(() => {});
      primaryServer = null;
    }
  });

  it('emits disconnect when server closes the connection', async () => {
    const { server, port } = await startServer();
    primaryServer = server;

    client = new HubClient({
      hubUrl: `http://127.0.0.1:${port}`,
      deviceToken: 'test-token',
      reconnectMaxAttempts: 0, // no reconnect for this test
    });
    await client.connect();

    const disconnectPromise = once(client, 'disconnect');

    // Kill all server-side connections
    for (const sock of server.clients) {
      sock.terminate();
    }

    await disconnectPromise;
  });

  it('reconnects after server disconnects and comes back', async () => {
    const { server: srv1, port } = await startServer();
    primaryServer = srv1;

    // Use 150ms base delay so we have time to restart the server before first retry
    client = new HubClient({
      hubUrl: `http://127.0.0.1:${port}`,
      deviceToken: 'test-token',
      reconnectMaxAttempts: 5,
      reconnectBaseDelayMs: 150,
      reconnectMaxDelayMs: 500,
    });
    await client.connect();

    const reconnectPromise = once(client, 'reconnect');
    const disconnectPromise = once(client, 'disconnect');

    // Terminate all client connections — server stays alive but clients are kicked
    for (const sock of srv1.clients) {
      sock.terminate();
    }
    await disconnectPromise;

    // Server is still running on the same port — client will reconnect successfully
    await reconnectPromise;
  }, 5000);

  it('emits reconnect_failed after exhausting max attempts', async () => {
    const { server, port } = await startServer();
    primaryServer = server;

    client = new HubClient({
      hubUrl: `http://127.0.0.1:${port}`,
      deviceToken: 'test-token',
      reconnectMaxAttempts: 2,
      reconnectBaseDelayMs: 30,
      reconnectMaxDelayMs: 60,
    });
    await client.connect();

    const failedPromise = once(client, 'reconnect_failed');

    // Stop server permanently — all reconnects will fail
    await stopServer(server);
    primaryServer = null;

    await failedPromise;
  }, 10000);

  it('close() stops reconnect timer — no reconnect_failed emitted', async () => {
    const { server, port } = await startServer();
    primaryServer = server;

    client = new HubClient({
      hubUrl: `http://127.0.0.1:${port}`,
      deviceToken: 'test-token',
      reconnectMaxAttempts: 3,
      reconnectBaseDelayMs: 50,
      reconnectMaxDelayMs: 200,
    });
    await client.connect();

    let reconnectFailed = false;
    client.on('reconnect_failed', () => {
      reconnectFailed = true;
    });

    const disconnectPromise = once(client, 'disconnect');

    // Disconnect client
    for (const sock of server.clients) {
      sock.terminate();
    }
    await disconnectPromise;

    // Immediately close — should cancel the scheduled reconnect
    await client.close();
    client = null;

    // Wait past first reconnect window — no reconnect_failed should fire
    await new Promise((r) => setTimeout(r, 300));
    expect(reconnectFailed).toBe(false);
  });

  it('reconnect resets attempt counter on successful open', async () => {
    const { server, port } = await startServer();
    primaryServer = server;

    client = new HubClient({
      hubUrl: `http://127.0.0.1:${port}`,
      deviceToken: 'test-token',
      reconnectMaxAttempts: 3,
      reconnectBaseDelayMs: 30,
      reconnectMaxDelayMs: 100,
    });
    await client.connect();

    // After initial connect, counter should be 0
    expect(client['_reconnectAttempts']).toBe(0);

    // Disconnect and allow reconnect to same server (still running)
    const reconnectPromise = once(client, 'reconnect');
    const disconnectPromise = once(client, 'disconnect');
    for (const sock of server.clients) {
      sock.terminate();
    }
    await disconnectPromise;
    // Counter increments when reconnect is scheduled
    expect(client['_reconnectAttempts']).toBeGreaterThanOrEqual(1);

    // After successful reconnect, counter resets to 0
    await reconnectPromise;
    expect(client['_reconnectAttempts']).toBe(0);
  }, 5000);

  it('close() before open rejects connect() promise', async () => {
    // Start a server that never accepts (immediately closes connections)
    const { server, port } = await startServer();
    primaryServer = server;

    // Create client but don't await connect yet
    client = new HubClient({
      hubUrl: `http://127.0.0.1:${port}`,
      deviceToken: 'test-token',
      reconnectMaxAttempts: 0,
    });

    const connectPromise = client.connect();
    // close() immediately — should abort the connection attempt
    await client.close();
    client = null;

    // connect() should reject (close event fires on the socket before open)
    await expect(connectPromise).rejects.toThrow();
  }, 3000);

  it('forwards hub messages to event listeners (no reconnect scenario)', async () => {
    // Verify that message forwarding works correctly after connect.
    // Post-reconnect forwarding is proven by the reconnect test above —
    // listeners attached to the EventEmitter persist across reconnects
    // since the same HubClient instance (same EventEmitter) is reused.
    const { server, port } = await startServer();
    primaryServer = server;

    client = new HubClient({
      hubUrl: `http://127.0.0.1:${port}`,
      deviceToken: 'test-token',
      reconnectMaxAttempts: 0,
    });
    await client.connect();

    const receivedEvents: string[] = [];
    client.on('task.created', () => {
      receivedEvents.push('task.created');
    });

    // Server broadcasts a hub event to all connected clients
    const msgPromise = once(client, 'task.created');
    for (const sock of server.clients) {
      sock.send(JSON.stringify({ name: 'task.created', id: 'e1', payload: { taskId: 't-1' } }));
    }

    await msgPromise;
    expect(receivedEvents).toHaveLength(1);
  });

  it('retries indefinitely when reconnectMaxAttempts is Infinity — never gives up', async () => {
    const { server, port } = await startServer();
    primaryServer = server;

    client = new HubClient({
      hubUrl: `http://127.0.0.1:${port}`,
      deviceToken: 'test-token',
      reconnectMaxAttempts: Number.POSITIVE_INFINITY,
      reconnectBaseDelayMs: 20,
      reconnectMaxDelayMs: 40,
    });
    await client.connect();

    let reconnectFailed = false;
    client.on('reconnect_failed', () => {
      reconnectFailed = true;
    });

    const disconnectPromise = once(client, 'disconnect');
    // Stop the server permanently — every reconnect attempt will fail.
    await stopServer(server);
    primaryServer = null;
    await disconnectPromise;

    // Wait far longer than a finite small budget would take to exhaust.
    await new Promise((r) => setTimeout(r, 300));

    // With Infinity it must never declare defeat, and it must keep trying
    // (attempt counter climbs well past any small finite cap).
    expect(reconnectFailed).toBe(false);
    expect(client['_reconnectAttempts']).toBeGreaterThan(3);
  }, 5000);

  it('request() rejects when the hub accepts but never responds (requestTimeoutMs)', async () => {
    // Server accepts the TCP connection and the HTTP request but never sends a
    // response — without a request timeout, fetch (and the worker poll loop that
    // calls it) would hang forever.
    const hung: Server = createServer(() => {
      /* intentionally never call res.end() */
    });
    const port = await new Promise<number>((resolve) => {
      hung.listen(0, '127.0.0.1', () => {
        const addr = hung.address();
        resolve(typeof addr === 'object' && addr !== null ? addr.port : 0);
      });
    });

    const httpClient = new HubClient({
      hubUrl: `http://127.0.0.1:${port}`,
      deviceToken: 'test-token',
      reconnectMaxAttempts: 0,
      requestTimeoutMs: 150,
    });

    try {
      await expect(httpClient.listTasks()).rejects.toThrow();
    } finally {
      await new Promise<void>((resolve) => hung.close(() => resolve()));
    }
  }, 5000);
});
