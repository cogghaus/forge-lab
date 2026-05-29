import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HubClient } from '../hub-client.js';

export function registerTaskTools(server: McpServer, hub: HubClient): void {
  server.tool(
    'list_tasks',
    'List tasks for a workspace, optionally filtered by status',
    {
      workspaceId: z.string().describe('The workspace ID'),
      status: z.string().optional().describe('Filter by task status (e.g. pending_agent, in_progress, done)'),
    },
    async (args) => {
      try {
        const query: Record<string, string> = { workspaceId: args.workspaceId };
        if (args.status) query['status'] = args.status;
        const data = await hub.get('/tasks', query);
        return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${String(err)}` }], isError: true };
      }
    }
  );

  server.tool(
    'get_task',
    'Get details for a specific task',
    { taskId: z.string().describe('The task ID') },
    async (args) => {
      try {
        const data = await hub.get(`/tasks/${args.taskId}`);
        return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${String(err)}` }], isError: true };
      }
    }
  );

  server.tool(
    'get_task_history',
    'Get the history/audit log for a specific task',
    { taskId: z.string().describe('The task ID') },
    async (args) => {
      try {
        const data = await hub.get(`/tasks/${args.taskId}/history`);
        return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${String(err)}` }], isError: true };
      }
    }
  );

  server.tool(
    'get_task_comments',
    'Get comments on a specific task',
    { taskId: z.string().describe('The task ID') },
    async (args) => {
      try {
        const data = await hub.get(`/tasks/${args.taskId}/comments`);
        return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${String(err)}` }], isError: true };
      }
    }
  );

  server.tool(
    'create_task',
    'Create a new task in a workspace',
    {
      workspaceId: z.string().describe('The workspace ID'),
      title: z.string().describe('Task title'),
      description: z.string().optional().describe('Task description'),
      priority: z.string().optional().describe('Task priority (e.g. low, medium, high, critical)'),
      assignedAgentId: z.string().optional().describe('Agent ID to assign the task to'),
    },
    async (args) => {
      try {
        const body: Record<string, unknown> = {
          projectPrefix: 'fl',
          title: args.title,
          status: args.assignedAgentId ? 'pending_agent' : 'pending_dispatcher_action',
        };
        if (args.description !== undefined) body['description'] = args.description;
        if (args.priority !== undefined) body['priority'] = args.priority;
        if (args.assignedAgentId !== undefined) body['assignedAgentId'] = args.assignedAgentId;

        const data = await hub.post(`/workspaces/${args.workspaceId}/tasks`, body);
        return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${String(err)}` }], isError: true };
      }
    }
  );

  server.tool(
    'cancel_task',
    'Cancel a task in a workspace',
    {
      workspaceId: z.string().describe('The workspace ID'),
      taskId: z.string().describe('The task ID'),
      reason: z.string().optional().describe('Reason for cancellation'),
    },
    async (args) => {
      try {
        const body = args.reason !== undefined ? { reason: args.reason } : undefined;
        const data = await hub.post(`/workspaces/${args.workspaceId}/tasks/${args.taskId}/cancel`, body);
        return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${String(err)}` }], isError: true };
      }
    }
  );

  server.tool(
    'retry_task',
    'Retry a failed or cancelled task',
    {
      workspaceId: z.string().describe('The workspace ID'),
      taskId: z.string().describe('The task ID'),
    },
    async (args) => {
      try {
        const data = await hub.post(`/workspaces/${args.workspaceId}/tasks/${args.taskId}/retry`);
        return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${String(err)}` }], isError: true };
      }
    }
  );

  server.tool(
    'assign_task',
    'Assign or unassign a task to an agent',
    {
      workspaceId: z.string().describe('The workspace ID'),
      taskId: z.string().describe('The task ID'),
      agentId: z.string().nullable().describe('Agent ID to assign, or null to unassign'),
    },
    async (args) => {
      try {
        const data = await hub.patch(`/workspaces/${args.workspaceId}/tasks/${args.taskId}/assign`, { agentId: args.agentId });
        return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${String(err)}` }], isError: true };
      }
    }
  );

  server.tool(
    'add_task_comment',
    'Add a comment to a task',
    {
      taskId: z.string().describe('The task ID'),
      body: z.string().describe('Comment text'),
    },
    async (args) => {
      try {
        const data = await hub.post(`/tasks/${args.taskId}/comments`, {
          body: args.body,
          authorType: 'user',
          authorId: 'claude',
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${String(err)}` }], isError: true };
      }
    }
  );
}
