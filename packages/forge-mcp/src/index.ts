import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { HubClient } from './hub-client.js';
import { registerWorkspaceTools } from './tools/workspaces.js';
import { registerTaskTools } from './tools/tasks.js';
import { registerAnalyticsTools } from './tools/analytics.js';
import { registerKnowledgeTools } from './tools/knowledge.js';
import { registerTriageTools } from './tools/triage.js';
import { registerActivityTools } from './tools/activity.js';
import { registerDeviceTools } from './tools/devices.js';

const HUB_URL = process.env['FORGE_HUB_URL'] ?? 'http://localhost:3000';
const MCP_EMAIL = process.env['FORGE_MCP_EMAIL'] ?? '';
const MCP_PASSWORD = process.env['FORGE_MCP_PASSWORD'] ?? '';
const MCP_API_KEY = process.env['FORGE_MCP_API_KEY'] ?? '';
const PORT = parseInt(process.env['PORT'] ?? '4000', 10);

if (!MCP_EMAIL || !MCP_PASSWORD) {
  console.error('FORGE_MCP_EMAIL and FORGE_MCP_PASSWORD are required');
  process.exit(1);
}

const hub = new HubClient(HUB_URL, MCP_EMAIL, MCP_PASSWORD);

// Pre-authenticate on startup
await hub.authenticate();
console.log('Authenticated with forge-hub');

// Build MCP server
const server = new McpServer({ name: 'forge-lab', version: '1.0.0' });
registerWorkspaceTools(server, hub);
registerTaskTools(server, hub);
registerAnalyticsTools(server, hub);
registerKnowledgeTools(server, hub);
registerTriageTools(server, hub);
registerActivityTools(server, hub);
registerDeviceTools(server, hub);

// HTTP server — one transport instance per request (stateless mode)
const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  // Auth check
  if (MCP_API_KEY) {
    const authHeader = (req.headers['authorization'] as string | undefined) ?? '';
    if (authHeader !== `Bearer ${MCP_API_KEY}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
  }

  if (req.url === '/mcp') {
    // Stateless mode: no sessionIdGenerator option needed
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const transport = new StreamableHTTPServerTransport({}) as any;
    await server.connect(transport);
    await transport.handleRequest(req, res);
    return;
  }

  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  res.writeHead(404);
  res.end();
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`forge-mcp listening on :${PORT}/mcp`);
});
