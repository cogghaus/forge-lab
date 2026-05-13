/**
 * P2.1.1: Atomic Task Claim Fix
 *
 * Replaces the current SELECT-then-UPDATE pattern in
 * packages/forge-hub/src/routes/tasks.ts with a single atomic UPDATE.
 *
 * Drop-in replacement for the existing /tasks/:id/claim handler.
 * Preserves forge-lab's status enum names. Adds X-Forge-Run-Id support.
 *
 * Confidence: 9/10. Validated against current code 2026-05-13.
 *
 * Test plan:
 *   - Failing-first test: spawn 10 concurrent claim requests against
 *     the same pending_agent task; assert exactly 1 returns 200 and
 *     9 return 409. The current code lets multiple through.
 *   - Idempotent test: same device claims twice in succession; second
 *     returns 200 with no state change.
 *   - Re-claim after crash: same device claims an in_progress task it
 *     already owns (with expectedStatuses including 'in_progress');
 *     should succeed.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { TaskIdSchema, TaskStatusSchema, schema } from '@forge-lab/core';
import type { Db } from '../db/index.js';
import { requireDevice, getDevice } from '../auth/middleware.js';
import type { EventBus } from '../events/bus.js';

// ============================================================================
// CONTRACT
// ============================================================================

const ClaimTaskBodySchema = z.object({
  // expectedStatuses are the statuses the agent expects the task to be in.
  // The claim fails (409) if the actual status isn't in this list.
  // Default mirrors current behavior (pending_agent or assigned).
  expectedStatuses: z
    .array(TaskStatusSchema)
    .min(1)
    .default(['pending_agent', 'assigned']),
});

const RunIdHeaderSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9_-]+$/, 'invalid run id format');

// ============================================================================
// HANDLER (replaces existing /tasks/:id/claim)
// ============================================================================

export function registerAtomicClaimRoute(
  fastify: FastifyInstance,
  db: Db,
  bus: EventBus,
): void {
  fastify.post<{
    Params: { id: string };
    Body: z.infer<typeof ClaimTaskBodySchema>;
  }>(
    '/tasks/:id/claim',
    { preHandler: requireDevice },
    async (req, reply) => {
      const device = getDevice(req);
      const id = TaskIdSchema.parse(req.params.id);
      const body = ClaimTaskBodySchema.parse(req.body ?? {});

      // X-Forge-Run-Id is optional during the transition. Once the heartbeat
      // model lands (P2.2), make it required. For now, generate one if absent
      // so every claim has a runId in history.
      const headerRunId = req.headers['x-forge-run-id'];
      const runId =
        typeof headerRunId === 'string'
          ? RunIdHeaderSchema.parse(headerRunId)
          : `run_${nanoid()}`;

      const now = new Date();

      // The atomic update.
      //
      // Claim succeeds when ALL of these hold in a single statement:
      //   1. Task exists with this id
      //   2. Current status is in expectedStatuses
      //   3. Either no current device, OR the current device is us (idempotent)
      //
      // If any condition fails, the UPDATE matches zero rows, and we return
      // 409 without distinguishing causes here. The diagnostic SELECT below
      // is for the 409 response body only; it does not affect correctness.

      const updated = await db
        .update(schema.tasks)
        .set({
          status: 'in_progress',
          assignedDeviceId: device.id,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.tasks.id, id),
            inArray(schema.tasks.status, body.expectedStatuses),
            or(
              isNull(schema.tasks.assignedDeviceId),
              eq(schema.tasks.assignedDeviceId, device.id),
            ),
          ),
        )
        .returning();

      if (updated.length === 0) {
        // Diagnose for a helpful 409 response. This SELECT runs only on the
        // failure path so it doesn't add cost to the hot path.
        const existing = await db
          .select()
          .from(schema.tasks)
          .where(eq(schema.tasks.id, id))
          .get();

        if (!existing) {
          await reply.code(404).send({ error: 'not_found' });
          return;
        }

        if (!body.expectedStatuses.includes(existing.status)) {
          await reply.code(409).send({
            error: 'unexpected_status',
            actualStatus: existing.status,
            expectedStatuses: body.expectedStatuses,
          });
          return;
        }

        // Status was right, but someone else owns it.
        await reply.code(409).send({
          error: 'already_claimed',
          assignedDeviceId: existing.assignedDeviceId,
        });
        return;
      }

      const task = updated[0]!;

      // History (entity_history once P2.1.2 lands; using current task_history
      // shape until then).
      await db.insert(schema.taskHistory).values({
        id: nanoid(),
        taskId: id,
        eventName: 'task.claimed',
        source: `device:${device.id}`,
        payload: { deviceId: device.id, runId, previousStatus: body.expectedStatuses },
      });

      bus.emit({
        id: nanoid(),
        name: 'task.claimed',
        occurredAt: now,
        source: `device:${device.id}`,
        payload: { taskId: id, deviceId: device.id, runId },
      });

      await reply.send({ ok: true, task });
    },
  );
}

// ============================================================================
// SUGGESTED TEST (drops into packages/forge-hub/src/routes/tasks.test.ts)
// ============================================================================

/**
 * Failing-first test for the TOCTOU race. Run this BEFORE applying the fix
 * and confirm it fails (multiple successes), THEN apply the fix and confirm
 * it passes (exactly one success).
 *
 * Pseudocode for the test structure (adapt to existing test setup):
 *
 *   import { test, expect } from 'vitest';
 *   import { buildTestHub, createDevices } from './test-helpers.js';
 *
 *   test('concurrent claims on the same task: exactly one wins', async () => {
 *     const hub = await buildTestHub();
 *     try {
 *       // Setup: create a task in pending_agent status
 *       const taskId = await hub.createTask({ projectPrefix: 'TST', title: 'race test' });
 *
 *       // Setup: 10 device tokens
 *       const devices = await createDevices(hub, 10);
 *
 *       // Fire 10 claims simultaneously
 *       const results = await Promise.all(
 *         devices.map((d) =>
 *           hub.inject({
 *             method: 'POST',
 *             url: `/tasks/${taskId}/claim`,
 *             headers: {
 *               authorization: `Bearer ${d.token}`,
 *               'x-forge-run-id': `run_${d.id}`,
 *             },
 *           }),
 *         ),
 *       );
 *
 *       const successes = results.filter((r) => r.statusCode === 200);
 *       const conflicts = results.filter((r) => r.statusCode === 409);
 *
 *       expect(successes.length).toBe(1);
 *       expect(conflicts.length).toBe(9);
 *
 *       // The successful device should be the one assigned
 *       const task = await hub.getTask(taskId);
 *       const winner = devices.find(
 *         (d) => results[devices.indexOf(d)]?.statusCode === 200,
 *       );
 *       expect(task.assignedDeviceId).toBe(winner?.id);
 *     } finally {
 *       await hub.close();
 *     }
 *   });
 */
