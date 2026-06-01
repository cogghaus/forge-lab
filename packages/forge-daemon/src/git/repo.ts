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

/** The per-task branch name worker agents push and open PRs from. */
export function taskBranch(taskId: string): string {
  return `forge/${taskId}`;
}

/**
 * Git credential helper supplying the GitHub token from the GH_TOKEN env var at
 * fetch/push time. This keeps the token OUT of the remote URL and `.git/config`,
 * so passive commands the agent might run (`git remote -v`, `cat .git/config`)
 * don't expose it. The agent inherits GH_TOKEN in its env (set by the daemon).
 */
export const CREDENTIAL_HELPER =
  '!f() { test "$1" = get && printf "username=x-access-token\\npassword=%s\\n" "$GH_TOKEN"; }; f';

/**
 * Default GitOps: shells out to `git`. Clones (or reuses) the repo at
 * `${workdir}/repo` with the token supplied via a credential helper (never the
 * URL), configures the bot identity, HARD-resets + cleans the base branch to the
 * remote so a reused checkout carries no leftover state from a prior task, then
 * cuts a fresh per-task branch. Workers run one task at a time
 * (enforced: repoUrl requires maxConcurrentTasks=1), so reuse is safe.
 */
export const defaultGitOps: GitOps = {
  async checkout(req: RepoCheckoutRequest): Promise<RepoCheckout> {
    const repoDir = path.join(req.workdir, 'repo');
    // The helper reads GH_TOKEN; set it from the explicit token so this op does
    // not depend on ambient env.
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_TOKEN: req.token };
    const git = (args: string[], cwd?: string): Promise<unknown> =>
      execFileAsync('git', args, cwd ? { cwd, env } : { env });

    const hasGit = await fs
      .access(path.join(repoDir, '.git'))
      .then(() => true)
      .catch(() => false);

    if (!hasGit) {
      await fs.mkdir(req.workdir, { recursive: true });
      await fs.rm(repoDir, { recursive: true, force: true });
      // Clean URL + helper-supplied credential — no token persisted in config.
      await git(['-c', `credential.helper=${CREDENTIAL_HELPER}`, 'clone', '--branch', req.baseBranch, req.repoUrl, repoDir]);
    } else {
      await git(['remote', 'set-url', 'origin', req.repoUrl], repoDir);
    }

    // Persist the helper + identity so the agent's later fetch/push authenticate.
    await git(['config', 'credential.helper', CREDENTIAL_HELPER], repoDir);
    await git(['config', 'user.name', req.userName], repoDir);
    await git(['config', 'user.email', req.userEmail], repoDir);
    await git(['fetch', 'origin', req.baseBranch], repoDir);
    // Clean reuse: discard any tracked edits AND untracked files from a prior task.
    await git(['checkout', '-B', req.baseBranch, `origin/${req.baseBranch}`], repoDir);
    await git(['reset', '--hard', `origin/${req.baseBranch}`], repoDir);
    await git(['clean', '-fdx'], repoDir);
    const branch = taskBranch(req.taskId);
    await git(['checkout', '-B', branch], repoDir);

    return { repoDir, branch, baseBranch: req.baseBranch };
  },
};
