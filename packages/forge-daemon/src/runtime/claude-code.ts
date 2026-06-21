import { promises as fs } from 'node:fs';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { nanoid } from 'nanoid';
import type {
  AgentRuntime,
  AgentRuntimeSpawnConfig,
  RuntimeInstance,
} from '@forge-lab/core';
import { doneFilePath, taskFilePath, writeInstructionFile } from '../sync/task-file.js';

/**
 * Injection point for tests. Real callers use {@link defaultSpawner} which
 * delegates to node:child_process. Tests pass a fake spawner that records the
 * command and args without actually executing anything.
 */
export interface RuntimeSpawner {
  spawn(
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ): SpawnedProcess;
}

export interface SpawnOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  detached?: boolean;
}

export interface SpawnedProcess {
  readonly pid: number | null;
  kill(signal?: NodeJS.Signals): boolean;
  readonly killed: boolean;
}

const defaultSpawner: RuntimeSpawner = {
  spawn(command, args, options) {
    const child: ChildProcess = nodeSpawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      detached: options.detached ?? true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.unref();
    return {
      pid: child.pid ?? null,
      kill: (signal) => child.kill(signal),
      get killed() {
        return child.killed;
      },
    };
  },
};

export interface ClaudeCodeRuntimeOptions {
  /** Path to the claude binary. Defaults to "claude" (resolved from PATH). */
  claudePath?: string;
  /**
   * Wrap the claude invocation in `wt.exe new-tab` so each agent lands in its
   * own Windows Terminal tab. Defaults to true on win32, false elsewhere.
   */
  useWindowsTerminal?: boolean;
  /** Tab color passed to `wt.exe --tabColor` when using Windows Terminal. */
  tabColor?: string;
  /**
   * Template for the Windows Terminal tab title. Supports `{agentId}` and
   * `{taskId}` placeholders.
   */
  tabTitleTemplate?: string;
  /**
   * Pass `--dangerously-skip-permissions` to claude. Required for unattended
   * runs where no human is present to approve tool calls. When using Windows
   * Terminal tabs for developer observation, leave this false so tool calls
   * require manual approval. Defaults to false.
   */
  dangerouslySkipPermissions?: boolean;
  /**
   * Claude model to use. Passed as `--model <model>` to claude.
   * Defaults to 'claude-sonnet-4-6' when unset to prevent the claude CLI
   * from falling back to Opus.
   */
  model?: string;
  /** Extra environment variables merged into the spawned process env. */
  env?: Record<string, string>;
  /** Injected spawner (tests). Defaults to {@link defaultSpawner}. */
  spawner?: RuntimeSpawner;
}

interface LiveInstance {
  runtime: RuntimeInstance;
  proc: SpawnedProcess;
  workdir: string;
  taskId: string | null;
}

/**
 * Spawns Claude Code per task and reports lifecycle via the AgentRuntime
 * contract. On Windows each agent opens in its own Windows Terminal tab; on
 * other platforms claude is spawned directly in the background.
 *
 * Process lifecycle: vibe-forge fires-and-forgets agents and does not track
 * PIDs. forge-lab layers file-based liveness on top — `isAlive()` returns
 * true while the task file exists without a done marker, and `stop()` removes
 * the task file as a soft "please exit" signal (Phase 2 adds a dedicated
 * signal file for worker-loop coordination).
 */
export class ClaudeCodeRuntime implements AgentRuntime {
  readonly id = 'claude-code';
  readonly displayName = 'Claude Code';
  readonly capabilities = { supportsStreaming: true, supportsTools: true } as const;

  private readonly claudePath: string;
  private readonly useWindowsTerminal: boolean;
  private readonly tabColor: string;
  private readonly tabTitleTemplate: string;
  private readonly dangerouslySkipPermissions: boolean;
  private readonly model: string | undefined;
  private readonly extraEnv: Record<string, string>;
  private readonly spawner: RuntimeSpawner;
  private readonly instances = new Map<string, LiveInstance>();

  constructor(opts: ClaudeCodeRuntimeOptions = {}) {
    this.claudePath = opts.claudePath ?? 'claude';
    this.useWindowsTerminal = opts.useWindowsTerminal ?? process.platform === 'win32';
    this.tabColor = opts.tabColor ?? '#f97316';
    this.tabTitleTemplate = opts.tabTitleTemplate ?? 'forge-lab :: {agentId} :: {taskId}';
    this.dangerouslySkipPermissions = opts.dangerouslySkipPermissions ?? false;
    this.model = opts.model;
    this.extraEnv = opts.env ?? {};
    this.spawner = opts.spawner ?? defaultSpawner;
  }

  spawn(
    config: AgentRuntimeSpawnConfig,
    initialPrompt: string,
  ): Promise<RuntimeInstance> {
    const systemPrompt = config.personality;
    const tabTitle = this.tabTitleTemplate
      .replace('{agentId}', config.agentId)
      .replace('{taskId}', config.taskId ?? 'idle');

    const claudeArgs: string[] = ['--system-prompt', systemPrompt];
    const model = this.model ?? 'claude-sonnet-4-6';
    claudeArgs.push('--model', model);
    if (this.dangerouslySkipPermissions) {
      claudeArgs.push('--dangerously-skip-permissions');
    }
    claudeArgs.push(initialPrompt);

    const env: NodeJS.ProcessEnv = { ...process.env, ...this.extraEnv };

    let proc: SpawnedProcess;
    if (this.useWindowsTerminal) {
      const wtArgs: string[] = [
        '-w',
        '0',
        'new-tab',
        '--title',
        tabTitle,
        '--tabColor',
        this.tabColor,
        '-d',
        config.workdir,
        this.claudePath,
        ...claudeArgs,
      ];
      proc = this.spawner.spawn('wt.exe', wtArgs, { env, detached: true });
    } else {
      proc = this.spawner.spawn(this.claudePath, claudeArgs, {
        cwd: config.workdir,
        env,
        detached: true,
      });
    }

    const instance: RuntimeInstance = {
      id: nanoid(),
      runtimeId: this.id,
      agentId: config.agentId,
      pid: proc.pid,
      startedAt: new Date(),
      metadata: {
        workdir: config.workdir,
        taskId: config.taskId,
        tabTitle,
        useWindowsTerminal: this.useWindowsTerminal,
      },
    };

    this.instances.set(instance.id, {
      runtime: instance,
      proc,
      workdir: config.workdir,
      taskId: config.taskId,
    });

    return Promise.resolve(instance);
  }

  async sendInstruction(instance: RuntimeInstance, text: string): Promise<void> {
    const live = this.instances.get(instance.id);
    if (!live?.taskId) {
      throw new Error('sendInstruction: no active task for instance');
    }
    await writeInstructionFile(live.workdir, live.taskId, text);
  }

  async stop(instance: RuntimeInstance): Promise<void> {
    const live = this.instances.get(instance.id);
    if (!live) return;
    if (live.proc.pid !== null && !live.proc.killed) {
      try {
        live.proc.kill('SIGTERM');
      } catch {
        // best-effort; wt.exe has already exited on Windows
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
    return hasTask && !hasDone;
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
