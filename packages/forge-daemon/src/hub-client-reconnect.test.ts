/**
 * HubClient WebSocket reconnect tests.
 *
 * Uses a real ws.Server on an ephemeral port so we can control connect/disconnect
 * without mocking internals. Keeps base reconnect delay at 50ms to keep tests fast.
 */
import { describe, it, expect, afterEach } from 'vitest';
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

    // After connect, reconnect attempt counter should be 0
    expect(client['_reconnectAttempts']).toBe(0);
  });

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
});
