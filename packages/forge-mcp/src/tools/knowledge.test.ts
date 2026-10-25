import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createHub, type Hub } from '@forge-lab/hub';
import { HubClient } from '../hub-client.js';
import { registerKnowledgeTools } from './knowledge.js';

// The knowledge tools must call routes that exist on the hub. This runs the
// real tools through a real MCP client against a real hub, so a path drift
// (the original bug: /docs and /docs/:id, which match no hub route) fails here.

const EMAIL = 'admin@example.com';
const PASSWORD = 'password123';

interface ToolText {
  isError?: boolean;
  content: { type: string; text: string }[];
}

describe('knowledge tools against a live hub', () => {
  let hub: Hub;
  let client: Client;
  let workspaceId: string;

  beforeEach(async () => {
    hub = await createHub({
      config: {
        port: 0,
        host: '127.0.0.1',
        databaseUrl: ':memory:',
        sessionSecret: 'test-secret-for-mcp-knowledge-test-xxxxxxxx',
        sessionTtlHours: 24,
        bcryptCost: 10,
        cookieSecure: false,
        appBaseUrl: 'http://localhost:3001',
        reclaimSweepSeconds: 0,
      },
    });
    const hubUrl = await hub.fastify.listen({ port: 0, host: '127.0.0.1' });
    await fetch(`${hubUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });

    const hubClient = new HubClient(hubUrl, EMAIL, PASSWORD);
    await hubClient.authenticate();
    const ws = await hubClient.post<{ id: string }>('/workspaces', { name: 'KB', slug: 'kb' });
    workspaceId = ws.id;

    const server = new McpServer({ name: 'test', version: '0.0.0' });
    registerKnowledgeTools(server, hubClient);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await hub.close();
  });

  async function call(name: string, args: Record<string, string>): Promise<ToolText> {
    return (await client.callTool({ name, arguments: args })) as ToolText;
  }

  function textOf(result: ToolText): string {
    return result.content.map((c) => c.text).join('');
  }

  it('create_doc, list_docs and get_doc round-trip through the hub', async () => {
    const created = await call('create_doc', {
      workspaceId,
      key: 'auth-design',
      title: 'Auth design',
      content: 'Sessions are 32-byte random tokens.',
      category: 'architecture',
    });
    expect(textOf(created)).not.toMatch(/^Error/);
    expect(created.isError).not.toBe(true);

    const listed = await call('list_docs', { workspaceId });
    expect(listed.isError).not.toBe(true);
    expect(textOf(listed)).toContain('auth-design');

    const fetched = await call('get_doc', { workspaceId, key: 'auth-design' });
    expect(fetched.isError).not.toBe(true);
    expect(textOf(fetched)).toContain('Sessions are 32-byte random tokens.');
  });

  it('list_docs passes the category filter through', async () => {
    for (const [key, category] of [
      ['an-adr', 'adr'],
      ['a-runbook', 'runbook'],
    ] as const) {
      await call('create_doc', { workspaceId, key, title: key, content: 'x', category });
    }
    const listed = await call('list_docs', { workspaceId, category: 'runbook' });
    expect(listed.isError).not.toBe(true);
    expect(textOf(listed)).toContain('a-runbook');
    expect(textOf(listed)).not.toContain('an-adr');
  });
});
