import { spawn as nodeSpawn } from 'node:child_process';
import path from 'node:path';
import { ReviewConfigSchema } from '@forge-lab/core';
import type { Task, ReviewConfig } from '@forge-lab/core';
import { composeSystemPrompt } from '@forge-lab/agents';
import type { PersonalityRegistry } from '@forge-lab/agents';
import type { HubClient } from './hub-client.js';

/** Max bytes of review output posted as a comment. Prevents oversized inserts. */
const MAX_COMMENT_CHARS = 48_000;

const TRUNCATION_NOTICE =
  '\n\n---\n*(Review output truncated — exceeded 48 000 character limit.)*';

export interface ReviewSpawnOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ReviewProcess {
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  on(event: 'exit', listener: (code: number | null) => void): void;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface ReviewSpawner {
  spawn(command: string, args: string[], options: ReviewSpawnOptions): ReviewProcess;
}

const defaultSpawner: ReviewSpawner = {
  spawn(command, args, options) {
    return nodeSpawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as unknown as ReviewProcess;
  },
};

export interface ReviewRunnerOptions {
  hubClient: HubClient;
  personalityRegistry: PersonalityRegistry;
  workdir: string;
  claudePath?: string;
  dangerouslySkipPermissions?: boolean;
  spawner?: ReviewSpawner;
  /** Default repo path for branch-type reviews. Can be overridden per-task via reviewConfig.repoPath. */
  defaultRepoPath?: string;
  /** Default base branch for branch-type diff resolution (default: 'main'). */
  defaultBaseBranch?: string;
  /**
   * Injectable command runner for testing branch/PR diff resolution.
   * Receives (command, args, cwd?) and returns the stdout string.
   * Defaults to running the command via the spawner.
   */
  commandRunner?: (command: string, args: string[], cwd?: string) => Promise<string>;
}

/**
 * Runs a one-shot vibe-forge review for a task with taskKind === 'review'.
 *
 * For 'diff' targetType: reads the diff from task.description.
 * For 'branch' targetType: runs `git diff <base>...<branch>` to resolve the diff.
 * For 'pr' targetType: runs `gh pr diff <number>` to resolve the diff.
 * Posts findings as a task comment and completes (or fails) the task.
 */
export class ReviewRunner {
  private readonly hubClient: HubClient;
  private readonly registry: PersonalityRegistry;
  private readonly workdir: string;
  private readonly claudePath: string;
  private readonly dangerouslySkipPermissions: boolean;
  private readonly spawner: ReviewSpawner;
  private readonly defaultRepoPath: string | undefined;
  private readonly defaultBaseBranch: string;
  private readonly commandRunner: (command: string, args: string[], cwd?: string) => Promise<string>;

  constructor(opts: ReviewRunnerOptions) {
    this.hubClient = opts.hubClient;
    this.registry = opts.personalityRegistry;
    this.workdir = opts.workdir;
    this.claudePath = opts.claudePath ?? 'claude';
    this.dangerouslySkipPermissions = opts.dangerouslySkipPermissions ?? false;
    this.spawner = opts.spawner ?? defaultSpawner;
    this.defaultRepoPath = opts.defaultRepoPath;
    this.defaultBaseBranch = opts.defaultBaseBranch ?? 'main';
    this.commandRunner = opts.commandRunner ?? this.defaultCommandRunner.bind(this);
  }

  async run(task: Task): Promise<void> {
    let reviewConfig: ReviewConfig;
    try {
      reviewConfig = ReviewConfigSchema.parse(JSON.parse(task.reviewConfig ?? '{}'));
    } catch {
      await this.hubClient.failTask(task.id, 'invalid or missing reviewConfig');
      return;
    }

    const personality = this.registry.get(reviewConfig.reviewer);
    if (!personality) {
      await this.hubClient.failTask(task.id, `unknown reviewer: ${reviewConfig.reviewer}`);
      return;
    }

    let systemPrompt: string;
    try {
      systemPrompt = await composeSystemPrompt({
        personality,
        projectContextPath: path.join(this.workdir, 'context', 'project-context.md'),
        agentOverridesDir: path.join(this.workdir, 'context', 'agent-overrides'),
        handoffDir: path.join(this.workdir, 'context', 'handoffs'),
      });
    } catch (err) {
      await this.hubClient.failTask(
        task.id,
        `failed to compose system prompt: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    let diff: string;
    try {
      diff = await this.resolveDiff(reviewConfig, task.description);
    } catch (err) {
      await this.hubClient.failTask(
        task.id,
        `failed to resolve diff: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    if (!diff.trim()) {
      await this.hubClient.failTask(task.id, 'review task has no diff in description');
      return;
    }

    // For branch/PR targets, description serves as optional context/focus prepended to the diff
    const context =
      reviewConfig.targetType !== 'diff' && task.description?.trim()
        ? task.description.trim()
        : null;
    const reviewPrompt = context ? `${context}\n\n---\n\n${diff}` : diff;

    let findings: string;
    try {
      findings = await this.spawnReview(systemPrompt, reviewPrompt);
    } catch (err) {
      await this.hubClient.failTask(
        task.id,
        `review process failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    const commentBody =
      findings.length > MAX_COMMENT_CHARS
        ? findings.slice(0, MAX_COMMENT_CHARS) + TRUNCATION_NOTICE
        : findings;

    try {
      await this.hubClient.postComment(task.id, commentBody, 'agent', reviewConfig.reviewer);
    } catch (err) {
      await this.hubClient.failTask(
        task.id,
        `failed to post findings: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    await this.hubClient.completeTask(task.id, `Review by ${reviewConfig.reviewer} complete`);
  }

  private async resolveDiff(reviewConfig: ReviewConfig, description: string | null): Promise<string> {
    switch (reviewConfig.targetType) {
      case 'diff':
        return description ?? '';
      case 'branch': {
        const repoPath = reviewConfig.repoPath ?? this.defaultRepoPath;
        const baseBranch = reviewConfig.baseBranch ?? this.defaultBaseBranch;
        const branch = reviewConfig.targetValue;
        if (!branch) throw new Error('branch targetType requires targetValue (branch name)');
        if (!repoPath)
          throw new Error(
            'branch targetType requires repoPath in reviewConfig or daemon defaultRepoPath',
          );
        return this.commandRunner('git', ['diff', `${baseBranch}...${branch}`], repoPath);
      }
      case 'pr': {
        const prNumber = reviewConfig.targetValue;
        if (!prNumber) throw new Error('pr targetType requires targetValue (PR number)');
        return this.commandRunner('gh', ['pr', 'diff', prNumber]);
      }
    }
  }

  private defaultCommandRunner(command: string, args: string[], cwd?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = this.spawner.spawn(command, args, {
        cwd,
        env: process.env as NodeJS.ProcessEnv,
      });
      const chunks: Buffer[] = [];
      proc.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
      proc.on('exit', (code) => {
        if (code !== 0) {
          reject(new Error(`${command} exited with code ${code ?? 'null'}`));
          return;
        }
        resolve(Buffer.concat(chunks).toString('utf8').trim());
      });
    });
  }

  private spawnReview(systemPrompt: string, prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = ['--print', '--system-prompt', systemPrompt];
      if (this.dangerouslySkipPermissions) {
        args.push('--dangerously-skip-permissions');
      }
      args.push(prompt);

      const proc = this.spawner.spawn(this.claudePath, args, {
        cwd: this.workdir,
        env: process.env as NodeJS.ProcessEnv,
      });

      const chunks: Buffer[] = [];
      proc.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
      proc.stderr?.on('data', () => {
        // stderr discarded — only stdout (findings) matters
      });

      proc.on('exit', (code) => {
        if (code !== 0) {
          reject(new Error(`claude exited with code ${code ?? 'null'}`));
          return;
        }
        resolve(Buffer.concat(chunks).toString('utf8').trim());
      });
    });
  }
}
