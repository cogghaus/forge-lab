import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HubClient } from '../hub-client.js';

export function registerAnalyticsTools(server: McpServer, hub: HubClient): void {
  server.tool(
    'get_analytics_overview',
    'Get analytics overview for a workspace with optional date range filtering',
    {
      workspaceId: z.string().describe('The workspace ID'),
      from: z.string().optional().describe('Start date in ISO format (e.g. 2025-01-01)'),
      to: z.string().optional().describe('End date in ISO format (e.g. 2025-12-31)'),
    },
    async (args) => {
      try {
        const query: Record<string, string> = {};
        if (args.from) query['from'] = args.from;
        if (args.to) query['to'] = args.to;
        const data = await hub.get(
          `/workspaces/${args.workspaceId}/analytics/overview`,
          Object.keys(query).length > 0 ? query : undefined
        );
        return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${String(err)}` }], isError: true };
      }
    }
  );

  server.tool(
    'get_agent_performance',
    'Get agent performance metrics for a workspace',
    {
      workspaceId: z.string().describe('The workspace ID'),
      from: z.string().optional().describe('Start date in ISO format'),
      to: z.string().optional().describe('End date in ISO format'),
    },
    async (args) => {
      try {
        const query: Record<string, string> = { workspaceId: args.workspaceId };
        if (args.from) query['from'] = args.from;
        if (args.to) query['to'] = args.to;
        const data = await hub.get('/agents/performance', query);
        return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${String(err)}` }], isError: true };
      }
    }
  );
}
