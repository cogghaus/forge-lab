import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HubClient } from '../hub-client.js';

export function registerDeviceTools(server: McpServer, hub: HubClient): void {
  server.tool(
    'list_devices',
    'List all registered devices/agents in the system',
    {},
    async () => {
      try {
        const data = await hub.get('/devices');
        return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${String(err)}` }], isError: true };
      }
    }
  );

  server.tool(
    'list_workspace_agents',
    'List agents registered to a specific workspace',
    { workspaceId: z.string().describe('The workspace ID') },
    async (args) => {
      try {
        const data = await hub.get(`/workspaces/${args.workspaceId}/agents`);
        return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${String(err)}` }], isError: true };
      }
    }
  );
}
