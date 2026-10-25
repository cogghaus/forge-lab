import { eq } from 'drizzle-orm';
import { schema } from '@forge-lab/core';
import type { Db } from '../db/index.js';

/**
 * Ownership rule for tasks with no workspace. With no workspace membership to
 * check, an unscoped task belongs to the user who created it: tasks.createdBy
 * is `user:<id>` (that user), `device:<id>` (the device's owning user), or
 * `system` (phase tasks, which inherit the owner of their parent chain).
 */

/** Parent hops to follow for `system` tasks before giving up (deny). */
const MAX_PARENT_DEPTH = 8;

/** Resolve the owning user of a task, or null when it cannot be determined. */
export async function resolveTaskOwnerUserId(db: Db, taskId: string): Promise<string | null> {
  let currentId: string | null = taskId;
  for (let depth = 0; currentId !== null && depth <= MAX_PARENT_DEPTH; depth++) {
    const task: { createdBy: string; parentId: string | null } | undefined = await db
      .select({ createdBy: schema.tasks.createdBy, parentId: schema.tasks.parentId })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, currentId))
      .get();
    if (!task) return null;
    if (task.createdBy.startsWith('user:')) return task.createdBy.slice('user:'.length);
    if (task.createdBy.startsWith('device:')) {
      const device = await db
        .select({ userId: schema.devices.userId })
        .from(schema.devices)
        .where(eq(schema.devices.id, task.createdBy.slice('device:'.length)))
        .get();
      return device?.userId ?? null;
    }
    if (task.createdBy !== 'system') return null;
    currentId = task.parentId;
  }
  return null;
}

/**
 * Every tasks.createdBy value that resolves directly to `userId`: the user
 * itself plus each device it has ever registered (a deregistered device's
 * tasks still belong to its owner).
 */
export async function createdByKeysForUser(db: Db, userId: string): Promise<string[]> {
  const devices = await db
    .select({ id: schema.devices.id })
    .from(schema.devices)
    .where(eq(schema.devices.userId, userId));
  return [`user:${userId}`, ...devices.map((d) => `device:${d.id}`)];
}
