import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HubClient } from '../hub-client.js';

export function registerTriageTools(server: McpServer, hub: HubClient): void {
  server.tool(
    'get_dispatcher_log',
    'Get the dispatcher log for a workspace showing recent triage decisions',
    { workspaceId: z.string().describe('The workspace ID') },
    async (args) => {
      try {
        const data = await hub.get(`/workspaces/${args.workspaceId}/dispatcher-log`);
        return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${String(err)}` }], isError: true };
      }
    }
  );
}
