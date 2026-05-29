import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HubClient } from '../hub-client.js';

export function registerKnowledgeTools(server: McpServer, hub: HubClient): void {
  server.tool(
    'list_docs',
    'List knowledge base documents for a workspace',
    {
      workspaceId: z.string().describe('The workspace ID'),
      status: z.string().optional().describe('Filter by document status'),
      category: z.string().optional().describe('Filter by document category'),
    },
    async (args) => {
      try {
        const query: Record<string, string> = { workspaceId: args.workspaceId };
        if (args.status) query['status'] = args.status;
        if (args.category) query['category'] = args.category;
        const data = await hub.get('/docs', query);
        return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${String(err)}` }], isError: true };
      }
    }
  );

  server.tool(
    'get_doc',
    'Get a specific knowledge base document',
    { docId: z.string().describe('The document ID') },
    async (args) => {
      try {
        const data = await hub.get(`/docs/${args.docId}`);
        return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${String(err)}` }], isError: true };
      }
    }
  );

  server.tool(
    'create_doc',
    'Create a new knowledge base document',
    {
      workspaceId: z.string().describe('The workspace ID'),
      key: z.string().describe('Unique document key/slug'),
      title: z.string().describe('Document title'),
      content: z.string().describe('Document content (markdown)'),
      category: z.string().describe('Document category'),
    },
    async (args) => {
      try {
        const data = await hub.post('/docs', {
          workspaceId: args.workspaceId,
          key: args.key,
          title: args.title,
          content: args.content,
          category: args.category,
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${String(err)}` }], isError: true };
      }
    }
  );
}
