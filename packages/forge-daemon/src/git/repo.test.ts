import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { defaultGitOps, taskBranch } from './repo.js';

const exec = promisify(execFile);

describe('taskBranch', () => {
  it('namespaces the task id under forge/', () => {
    expect(taskBranch('hal-001')).toBe('forge/hal-001');
  });
});

describe('defaultGitOps.checkout (real git)', () => {
  let tmp: string;
  let srcRepo: string;
  let workdir: string;

  const git = (args: string[], cwd: string): Promise<unknown> =>
    exec('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-git-'));
    srcRepo = path.join(tmp, 'src');
    workdir = path.join(tmp, 'wd');
    await fs.mkdir(srcRepo, { recursive: true });
    await git(['init', '-b', 'main'], srcRepo);
    await git(['config', 'user.name', 'src'], srcRepo);
    await git(['config', 'user.email', 'src@example.com'], srcRepo);
    await fs.writeFile(path.join(srcRepo, 'file.txt'), 'v1\n', 'utf8');
    await git(['add', '-A'], srcRepo);
    await git(['commit', '-m', 'init'], srcRepo);
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  const req = (taskId: string) => ({
    workdir,
    repoUrl: srcRepo,
    baseBranch: 'main',
    taskId,
    token: 'x',
    userName: 'forge-lab[bot]',
    userEmail: 'forge-lab@example.com',
  });

  it('clones onto a fresh per-task branch with the base content', async () => {
    const co = await defaultGitOps.checkout(req('t-1'));
    expect(co.branch).toBe('forge/t-1');
    expect(co.repoDir).toBe(path.join(workdir, 'repo'));
    const branch = (await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: co.repoDir })).stdout.trim();
    expect(branch).toBe('forge/t-1');
    expect((await fs.readFile(path.join(co.repoDir, 'file.txt'), 'utf8')).trim()).toBe('v1');
  });

  it('does NOT persist the token in the remote URL or .git/config', async () => {
    const co = await defaultGitOps.checkout(req('t-1'));
    const remote = (await exec('git', ['remote', 'get-url', 'origin'], { cwd: co.repoDir })).stdout;
    expect(remote).not.toContain('x-access-token');
    const cfg = await fs.readFile(path.join(co.repoDir, '.git', 'config'), 'utf8');
    // The credential helper references $GH_TOKEN, never a literal token value.
    expect(cfg).toContain('GH_TOKEN');
    expect(cfg).not.toContain('password=x');
  });

  it('cleans a reused checkout: prior tracked edits and untracked files are gone', async () => {
    const co1 = await defaultGitOps.checkout(req('t-1'));
    // Simulate a prior task leaving a dirty worktree.
    await fs.writeFile(path.join(co1.repoDir, 'file.txt'), 'DIRTY\n', 'utf8');
    await fs.writeFile(path.join(co1.repoDir, 'scratch.txt'), 'leftover\n', 'utf8');

    const co2 = await defaultGitOps.checkout(req('t-2'));
    expect(co2.branch).toBe('forge/t-2');
    // Tracked edit reverted to base; untracked scratch file removed.
    expect((await fs.readFile(path.join(co2.repoDir, 'file.txt'), 'utf8')).trim()).toBe('v1');
    await expect(fs.access(path.join(co2.repoDir, 'scratch.txt'))).rejects.toThrow();
  });
});
