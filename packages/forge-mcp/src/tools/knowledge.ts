import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HubClient } from '../hub-client.js';

// Hub routes: /workspaces/:workspaceId/docs (GET list, POST create) and
// /workspaces/:workspaceId/docs/:key (GET one). Docs are addressed by key
// within a workspace; the hub has no lookup by doc id.

function docsPath(workspaceId: string, key?: string): string {
  const base = `/workspaces/${encodeURIComponent(workspaceId)}/docs`;
  return key === undefined ? base : `${base}/${encodeURIComponent(key)}`;
}

export function registerKnowledgeTools(server: McpServer, hub: HubClient): void {
  server.tool(
    'list_docs',
    'List knowledge base documents for a workspace',
    {
      workspaceId: z.string().describe('The workspace ID'),
      status: z.string().optional().describe('Filter by document status (default active; "all" for any)'),
      category: z.string().optional().describe('Filter by document category'),
    },
    async (args) => {
      try {
        const query: Record<string, string> = {};
        if (args.status) query['status'] = args.status;
        if (args.category) query['category'] = args.category;
        const data = await hub.get(docsPath(args.workspaceId), query);
        return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${String(err)}` }], isError: true };
      }
    }
  );

  server.tool(
    'get_doc',
    'Get a specific knowledge base document by its key',
    {
      workspaceId: z.string().describe('The workspace ID'),
      key: z.string().describe('The document key/slug'),
    },
    async (args) => {
      try {
        const data = await hub.get(docsPath(args.workspaceId, args.key));
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
        const data = await hub.post(docsPath(args.workspaceId), {
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
