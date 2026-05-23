import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, index, primaryKey } from 'drizzle-orm/sqlite-core';

const timestampMs = (name: string) => integer(name, { mode: 'timestamp_ms' });
const nowDefault = sql`(unixepoch() * 1000)`;

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role', { enum: ['admin', 'user'] })
    .notNull()
    .default('user'),
  createdAt: timestampMs('created_at').notNull().default(nowDefault),
});

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestampMs('expires_at').notNull(),
    createdAt: timestampMs('created_at').notNull().default(nowDefault),
  },
  (t) => ({
    userIdIdx: index('sessions_user_id_idx').on(t.userId),
  }),
);

export const devices = sqliteTable(
  'devices',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    hostname: text('hostname'),
    platform: text('platform', { enum: ['win32', 'darwin', 'linux'] }),
    tokenHash: text('token_hash').notNull().unique(),
    lastSeen: timestampMs('last_seen'),
    createdAt: timestampMs('created_at').notNull().default(nowDefault),
  },
  (t) => ({
    userIdIdx: index('devices_user_id_idx').on(t.userId),
  }),
);

export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').references(() => workspaces.id),
    projectPrefix: text('project_prefix').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    status: text('status', {
      enum: [
        'pending_design',
        'design_review',
        'pending_agent',
        'assigned',
        'in_progress',
        'pending_dispatcher_action',
        'completed',
        'failed',
        'cancelled',
      ],
    })
      .notNull()
      .default('pending_agent'),
    priority: text('priority', { enum: ['low', 'normal', 'high', 'urgent'] })
      .notNull()
      .default('normal'),
    assignedDeviceId: text('assigned_device_id').references(() => devices.id, {
      onDelete: 'set null',
    }),
    assignedAgentId: text('assigned_agent_id'),
    createdBy: text('created_by').notNull(),
    createdAt: timestampMs('created_at').notNull().default(nowDefault),
    updatedAt: timestampMs('updated_at').notNull().default(nowDefault),
    completedAt: timestampMs('completed_at'),
  },
  (t) => ({
    statusIdx: index('tasks_status_idx').on(t.status),
    projectIdx: index('tasks_project_idx').on(t.projectPrefix),
    assignedDeviceIdx: index('tasks_assigned_device_idx').on(t.assignedDeviceId),
    workspaceIdx: index('tasks_workspace_idx').on(t.workspaceId),
  }),
);

export const taskHistory = sqliteTable(
  'task_history',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').references(() => workspaces.id),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    eventName: text('event_name').notNull(),
    source: text('source').notNull(),
    payload: text('payload', { mode: 'json' }).notNull(),
    createdAt: timestampMs('created_at').notNull().default(nowDefault),
  },
  (t) => ({
    taskIdIdx: index('task_history_task_id_idx').on(t.taskId),
  }),
);

export const taskInstructions = sqliteTable(
  'task_instructions',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').references(() => workspaces.id),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    priority: text('priority', { enum: ['redirect', 'stop'] }).notNull(),
    body: text('body').notNull(),
    createdBy: text('created_by').notNull(),
    acknowledgedAt: timestampMs('acknowledged_at'),
    createdAt: timestampMs('created_at').notNull().default(nowDefault),
  },
  (t) => ({
    taskIdIdx: index('task_instructions_task_id_idx').on(t.taskId),
  }),
);

export const taskComments = sqliteTable(
  'task_comments',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').references(() => workspaces.id),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    authorType: text('author_type', { enum: ['user', 'agent', 'dispatcher', 'system'] }).notNull(),
    authorId: text('author_id').notNull(),
    body: text('body').notNull(),
    createdAt: timestampMs('created_at').notNull().default(nowDefault),
  },
  (t) => ({
    taskIdIdx: index('task_comments_task_id_idx').on(t.taskId),
  }),
);

export const agents = sqliteTable(
  'agents',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').references(() => workspaces.id),
    name: text('name').notNull(),
    personality: text('personality').notNull(),
    runtimeId: text('runtime_id').notNull(),
    config: text('config', { mode: 'json' }).notNull().default(sql`'{}'`),
    createdAt: timestampMs('created_at').notNull().default(nowDefault),
  },
  (t) => ({
    workspaceIdx: index('agents_workspace_idx').on(t.workspaceId),
  }),
);

export const agentInstances = sqliteTable(
  'agent_instances',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').references(() => workspaces.id),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    deviceId: text('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    runtimeInstanceId: text('runtime_instance_id'),
    status: text('status', {
      enum: ['spawning', 'running', 'idle', 'stopping', 'stopped', 'crashed'],
    }).notNull(),
    startedAt: timestampMs('started_at').notNull().default(nowDefault),
    endedAt: timestampMs('ended_at'),
  },
  (t) => ({
    deviceIdx: index('agent_instances_device_idx').on(t.deviceId),
    taskIdx: index('agent_instances_task_idx').on(t.taskId),
    workspaceIdx: index('agent_instances_workspace_idx').on(t.workspaceId),
  }),
);

export const runtimeConfigs = sqliteTable(
  'runtime_configs',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    runtimeId: text('runtime_id').notNull(),
    name: text('name').notNull(),
    config: text('config', { mode: 'json' }).notNull(),
    createdAt: timestampMs('created_at').notNull().default(nowDefault),
  },
  (t) => ({
    userIdx: index('runtime_configs_user_idx').on(t.userId),
  }),
);

export const workspaces = sqliteTable(
  'workspaces',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    description: text('description'),
    ownerUserId: text('owner_user_id')
      .notNull()
      // RESTRICT: deleting a user who owns a workspace is blocked by design; transfer ownership first
      .references(() => users.id, { onDelete: 'restrict' }),
    status: text('status', { enum: ['active', 'archived', 'deleted'] })
      .notNull()
      .default('active'),
    budgetMonthlyCents: integer('budget_monthly_cents').notNull().default(0),
    createdAt: timestampMs('created_at').notNull().default(nowDefault),
    updatedAt: timestampMs('updated_at').notNull().default(nowDefault),
  },
  (t) => ({
    ownerIdx: index('workspaces_owner_idx').on(t.ownerUserId),
  }),
);

export const workspaceMembers = sqliteTable(
  'workspace_members',
  {
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['owner', 'admin', 'collaborator', 'viewer'] }).notNull(),
    joinedAt: timestampMs('joined_at').notNull().default(nowDefault),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.userId] }),
    userIdx: index('workspace_members_user_idx').on(t.userId),
  }),
);
