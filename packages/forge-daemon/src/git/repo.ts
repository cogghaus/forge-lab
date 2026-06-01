import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { promises as fs } from 'node:fs';

const execFileAsync = promisify(execFile);

export interface RepoCheckoutRequest {
  /** Daemon workdir; the checkout lives at `${workdir}/repo`. */
  workdir: string;
  /** https clone URL (no embedded credentials). */
  repoUrl: string;
  /** Base branch the per-task branch is cut from and the PR targets. */
  baseBranch: string;
  /** Task id — used to name the per-task branch. */
  taskId: string;
  /** GitHub token used for clone/fetch/push (x-access-token). */
  token: string;
  userName: string;
  userEmail: string;
}

export interface RepoCheckout {
  /** Absolute path to the checkout (the agent's working tree). */
  repoDir: string;
  /** The per-task branch that was created and checked out. */
  branch: string;
  baseBranch: string;
}

export interface GitOps {
  checkout(req: RepoCheckoutRequest): Promise<RepoCheckout>;
}

/** Insert an `x-access-token` credential into an https URL for non-interactive git. */
export function authedUrl(repoUrl: string, token: string): string {
  return repoUrl.replace(/^https:\/\//i, `https://x-access-token:${encodeURIComponent(token)}@`);
}

/** The per-task branch name worker agents push and open PRs from. */
export function taskBranch(taskId: string): string {
  return `forge/${taskId}`;
}

/**
 * Default GitOps: shells out to `git`. Clones (or reuses + fetches) the repo at
 * `${workdir}/repo`, configures the bot identity, resets the base branch to the
 * remote, and cuts a fresh per-task branch. Workers run one task at a time
 * (MAX_CONCURRENT_TASKS=1), so a single reused checkout is safe.
 */
export const defaultGitOps: GitOps = {
  async checkout(req: RepoCheckoutRequest): Promise<RepoCheckout> {
    const repoDir = path.join(req.workdir, 'repo');
    const url = authedUrl(req.repoUrl, req.token);
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    const git = (args: string[], cwd?: string): Promise<unknown> =>
      execFileAsync('git', args, cwd ? { cwd, env } : { env });

    const hasGit = await fs
      .access(path.join(repoDir, '.git'))
      .then(() => true)
      .catch(() => false);

    if (!hasGit) {
      await fs.mkdir(req.workdir, { recursive: true });
      await fs.rm(repoDir, { recursive: true, force: true });
      await git(['clone', '--branch', req.baseBranch, url, repoDir]);
    } else {
      // Reuse the existing checkout; refresh the credential (token rotates) and base.
      await git(['remote', 'set-url', 'origin', url], repoDir);
      await git(['fetch', 'origin', req.baseBranch], repoDir);
    }

    await git(['config', 'user.name', req.userName], repoDir);
    await git(['config', 'user.email', req.userEmail], repoDir);
    // Hard-reset the base branch to the remote so a reused checkout has no
    // leftover state from a prior task, then cut the per-task branch.
    await git(['checkout', '-B', req.baseBranch, `origin/${req.baseBranch}`], repoDir);
    const branch = taskBranch(req.taskId);
    await git(['checkout', '-B', branch], repoDir);

    return { repoDir, branch, baseBranch: req.baseBranch };
  },
};
