import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HubClient } from '../hub-client.js';

export function registerWorkspaceTools(server: McpServer, hub: HubClient): void {
  server.tool(
    'list_workspaces',
    'List all workspaces accessible to the authenticated user',
    {},
    async () => {
      try {
        const data = await hub.get('/workspaces');
        return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${String(err)}` }], isError: true };
      }
    }
  );

  server.tool(
    'get_workspace',
    'Get details for a specific workspace',
    { workspaceId: z.string().describe('The workspace ID') },
    async (args) => {
      try {
        const data = await hub.get(`/workspaces/${args.workspaceId}`);
        return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${String(err)}` }], isError: true };
      }
    }
  );

  server.tool(
    'get_workspace_context',
    'Get workspace context including queue depth, dispatcher history, and inbox tasks',
    { workspaceId: z.string().describe('The workspace ID') },
    async (args) => {
      try {
        const data = await hub.get(`/workspaces/${args.workspaceId}/context`);
        return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${String(err)}` }], isError: true };
      }
    }
  );
}
