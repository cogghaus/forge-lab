import { promises as fs, createWriteStream } from 'node:fs';
import { spawn as nodeSpawn } from 'node:child_process';
import path from 'node:path';
import { nanoid } from 'nanoid';
import type {
  AgentRuntime,
  AgentRuntimeSpawnConfig,
  RuntimeInstance,
} from '@forge-lab/core';
import { doneFilePath, taskFilePath } from '../sync/task-file.js';

// ---------------------------------------------------------------------------
// Spawner abstraction (injectable for tests)
// ---------------------------------------------------------------------------

/**
 * Minimal interface for a spawned background process.
 * Exposes stdout/stderr as readable streams so the runtime can pipe them to
 * a log file.
 */
export interface BackgroundProcess {
  readonly pid: number | undefined;
  kill(signal?: NodeJS.Signals): boolean;
  readonly killed: boolean;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  on(event: 'exit', listener: (code: number | null) => void): void;
}

export interface BackgroundSpawnOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface BackgroundSpawner {
  spawn(
    command: string,
    args: string[],
    options: BackgroundSpawnOptions,
  ): BackgroundProcess;
}

/**
 * Real spawner: starts `claude` with piped stdio and `detached: true` so the
 * daemon process can exit without killing the agent subprocess.
 */
export const defaultBackgroundSpawner: BackgroundSpawner = {
  spawn(command, args, options) {
    const child = nodeSpawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.unref();
    // ChildProcess satisfies BackgroundProcess structurally.
    return child as unknown as BackgroundProcess;
  },
};

// ---------------------------------------------------------------------------
// Runtime options
// ---------------------------------------------------------------------------

export interface BackgroundRuntimeOptions {
  /** Path to the claude binary. Defaults to "claude" (resolved from PATH). */
  claudePath?: string;
  /**
   * Pass `--dangerously-skip-permissions` to claude. Required for unattended
   * background runs where no human is present to approve tool calls.
   * Defaults to false; enable for production daemon use.
   */
  dangerouslySkipPermissions?: boolean;
  /** Extra environment variables merged into the spawned process env. */
  env?: Record<string, string>;
  /** Injected spawner (tests). Defaults to {@link defaultBackgroundSpawner}. */
  spawner?: BackgroundSpawner;
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface LiveInstance {
  runtime: RuntimeInstance;
  proc: BackgroundProcess;
  workdir: string;
  taskId: string | null;
}

// ---------------------------------------------------------------------------
// BackgroundRuntime
// ---------------------------------------------------------------------------

/**
 * Headless agent runtime for forge-lab background agents.
 *
 * Spawns `claude` directly (no terminal tab) with stdout and stderr piped
 * to `{workdir}/context/agent-logs/{taskId}.log`. The agent runs detached
 * so the daemon process can exit independently.
 *
 * **CLI flags:** Uses `--system-prompt <personality>` followed by the
 * initial prompt as a positional argument, matching the ClaudeCodeRuntime
 * convention. Add `--dangerously-skip-permissions` via the runtime option
 * for unattended runs where no human is available to approve tool calls.
 *
 * **Log path:** `{workdir}/context/agent-logs/{taskId}.log` (append mode).
 * The composed system prompt is passed to the runtime and may appear in
 * the log file. Treat log files as potentially sensitive.
 *
 * **Completion:** Detected via the `.forge/tasks/{taskId}.done` file
 * protocol. The spawned agent (or a wrapper hook) is responsible for
 * writing this file when the task is complete.
 *
 * **Liveness:** `isAlive()` combines file-based checks (task file present,
 * done file absent) with a PID signal-0 probe on POSIX platforms only.
 * Windows does not reliably throw ESRCH for terminated processes, so the
 * PID probe is skipped there and liveness falls back to file checks alone.
 *
 * **sendInstruction:** Not supported. BackgroundRuntime is one-shot — one
 * task per spawn. Calling `sendInstruction()` throws immediately.
 */
export class BackgroundRuntime implements AgentRuntime {
  readonly id = 'background';
  readonly displayName = 'Background (headless)';
  readonly capabilities = { supportsStreaming: false, supportsTools: true } as const;

  private readonly claudePath: string;
  private readonly dangerouslySkipPermissions: boolean;
  private readonly extraEnv: Record<string, string>;
  private readonly spawner: BackgroundSpawner;
  private readonly instances = new Map<string, LiveInstance>();

  constructor(opts: BackgroundRuntimeOptions = {}) {
    this.claudePath = opts.claudePath ?? 'claude';
    this.dangerouslySkipPermissions = opts.dangerouslySkipPermissions ?? false;
    this.extraEnv = opts.env ?? {};
    this.spawner = opts.spawner ?? defaultBackgroundSpawner;
  }

  async spawn(
    config: AgentRuntimeSpawnConfig,
    initialPrompt: string,
  ): Promise<RuntimeInstance> {
    // C5: null taskId means no completion tracking — fail fast rather than
    // silently generating an ephemeral ID that the daemon can never match.
    if (!config.taskId) {
      throw new Error('BackgroundRuntime requires a non-null taskId for completion tracking.');
    }
    const taskId = config.taskId;

    const logDir = path.join(config.workdir, 'context', 'agent-logs');
    await fs.mkdir(logDir, { recursive: true });

    const logPath = path.join(logDir, `${taskId}.log`);
    const logStream = createWriteStream(logPath, { flags: 'a' });
    // Ensure the file is created before we return (createWriteStream opens lazily).
    await new Promise<void>((resolve, reject) => {
      logStream.once('open', () => resolve());
      logStream.once('error', reject);
    });
    // C6: attach persistent error handler so disk-full / permissions errors
    // after pipe is established don't propagate as an unhandled 'error' event
    // and crash the daemon process.
    logStream.on('error', (err) => {
      process.stderr.write(
        `[BackgroundRuntime] log stream error for task ${taskId}: ${err.message}\n`,
      );
    });

    const claudeArgs: string[] = ['--system-prompt', config.personality];
    if (this.dangerouslySkipPermissions) {
      claudeArgs.push('--dangerously-skip-permissions');
    }
    claudeArgs.push(initialPrompt);

    const env: NodeJS.ProcessEnv = { ...process.env, ...this.extraEnv };

    // C1: if spawn throws, close the log stream to avoid an fd leak.
    let proc: BackgroundProcess;
    try {
      proc = this.spawner.spawn(this.claudePath, claudeArgs, {
        cwd: config.workdir,
        env,
      });
    } catch (err) {
      logStream.destroy();
      throw err;
    }

    proc.stdout?.pipe(logStream);
    proc.stderr?.pipe(logStream);

    const instanceId = nanoid();

    proc.on('exit', () => {
      logStream.end();
      this.instances.delete(instanceId);
    });

    const instance: RuntimeInstance = {
      id: instanceId,
      runtimeId: this.id,
      agentId: config.agentId,
      pid: proc.pid ?? null,
      startedAt: new Date(),
      metadata: {
        workdir: config.workdir,
        taskId,
        logPath,
      },
    };

    this.instances.set(instanceId, {
      runtime: instance,
      proc,
      workdir: config.workdir,
      taskId,
    });

    return instance;
  }

  /**
   * Not supported. BackgroundRuntime is one-shot; there is no stdin channel
   * to send mid-task instructions to the background process.
   */
  sendInstruction(_instance: RuntimeInstance, _text: string): Promise<void> {
    return Promise.reject(
      new Error(
        'BackgroundRuntime does not support mid-task instructions (one-shot runtime).',
      ),
    );
  }

  async stop(instance: RuntimeInstance): Promise<void> {
    const live = this.instances.get(instance.id);
    if (!live) return;
    if (live.proc.pid !== undefined && !live.proc.killed) {
      try {
        live.proc.kill('SIGTERM');
      } catch {
        // best-effort; process may have already exited
      }
    }
    if (live.taskId) {
      await fs.rm(taskFilePath(live.workdir, live.taskId), { force: true });
    }
    this.instances.delete(instance.id);
  }

  async isAlive(instance: RuntimeInstance): Promise<boolean> {
    const live = this.instances.get(instance.id);
    if (!live || !live.taskId) return false;

    const [hasTask, hasDone] = await Promise.all([
      fileExists(taskFilePath(live.workdir, live.taskId)),
      fileExists(doneFilePath(live.workdir, live.taskId)),
    ]);

    if (!hasTask || hasDone) return false;

    // C4: PID signal-0 probe is POSIX-only. On Windows, process.kill(pid, 0)
    // does not reliably throw ESRCH for terminated processes, so skipping the
    // check there avoids false negatives. On POSIX, ESRCH means the process
    // is definitely gone; other errors (EPERM) mean it exists but we can't
    // probe it — fall through and trust the file-based check.
    if (live.proc.pid !== undefined && process.platform !== 'win32') {
      try {
        process.kill(live.proc.pid, 0);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
          return false;
        }
        // EPERM: process exists, we lack permission to probe; trust files.
      }
    }

    return true;
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
