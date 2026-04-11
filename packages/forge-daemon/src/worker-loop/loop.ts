/**
 * Worker loop capability. After a runtime instance exits or a task completes,
 * check the hub for more claimable work for this device and continue if any.
 * Phase 2 expands this with liveness monitoring and auto-restart.
 */

export interface WorkerLoopDeps {
  hasMoreWork: () => Promise<boolean>;
  onMoreWork: () => Promise<void>;
}

export async function runWorkerLoop(deps: WorkerLoopDeps): Promise<void> {
  if (await deps.hasMoreWork()) {
    await deps.onMoreWork();
  }
}
