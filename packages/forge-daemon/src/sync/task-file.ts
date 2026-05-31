import { promises as fs, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import type { Task } from '@forge-lab/core';

export function taskDir(workdir: string): string {
  return path.join(workdir, '.forge', 'tasks');
}

export function taskFilePath(workdir: string, taskId: string): string {
  return path.join(taskDir(workdir), `${taskId}.md`);
}

export function doneFilePath(workdir: string, taskId: string): string {
  return path.join(taskDir(workdir), `${taskId}.done`);
}

export async function writeTaskFile(workdir: string, task: Task): Promise<void> {
  const dir = taskDir(workdir);
  await fs.mkdir(dir, { recursive: true });
  const body = [
    `# ${task.id}: ${task.title}`,
    '',
    `**Status:** ${task.status}`,
    `**Priority:** ${task.priority}`,
    '',
    task.description ?? '',
    '',
  ].join('\n');
  await fs.writeFile(taskFilePath(workdir, task.id), body, 'utf8');
}

/**
 * Write a minimal task-file marker for a synthetic (non-hub) task — e.g. the FM
 * dispatcher's `_fm_*` agent, which has no hub Task row. The background/mock
 * runtime's file-based `isAlive()` probe treats a missing task file as "dead",
 * so without this marker a still-running synthetic agent is reported dead on the
 * next poll. Cleaned up by {@link cleanupTaskFiles}.
 */
export async function writeSyntheticTaskFile(
  workdir: string,
  taskId: string,
  title: string,
): Promise<void> {
  const dir = taskDir(workdir);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    taskFilePath(workdir, taskId),
    `# ${taskId}: ${title}\n\n**Status:** in_progress\n`,
    'utf8',
  );
}

/** Path to the agent's stdout/stderr log for a task (written by the runtime). */
export function agentLogPath(workdir: string, taskId: string): string {
  return path.join(workdir, 'context', 'agent-logs', `${taskId}.log`);
}

/**
 * Truncate (or create) a task's agent log so it contains only the upcoming run.
 * The runtime appends to this file, and {@link cleanupTaskFiles} does not remove
 * it, so without a reset a re-spawn's log would still carry the prior attempt's
 * output — and a stale "Not logged in" marker would be misread as a fresh auth
 * failure. Call immediately before (re)spawning an agent.
 */
export async function resetAgentLog(workdir: string, taskId: string): Promise<void> {
  const p = agentLogPath(workdir, taskId);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, '', 'utf8');
}

/**
 * Read the tail of a task's agent log (last `maxBytes`). Returns '' if the log
 * does not exist or can't be read — callers use it for best-effort diagnostics
 * (e.g. detecting a transient auth failure), never as authoritative state.
 */
export async function readAgentLogTail(
  workdir: string,
  taskId: string,
  maxBytes = 4096,
): Promise<string> {
  try {
    const content = await fs.readFile(agentLogPath(workdir, taskId), 'utf8');
    return content.length > maxBytes ? content.slice(-maxBytes) : content;
  } catch {
    return '';
  }
}

export interface DoneResult {
  result?: string;
  /** ISO 8601 timestamp written by the agent. Informational; not used by the daemon. */
  completedAt?: string;
}

export async function readDoneFile(
  workdir: string,
  taskId: string,
): Promise<DoneResult | null> {
  try {
    const content = await fs.readFile(doneFilePath(workdir, taskId), 'utf8');
    return JSON.parse(content) as DoneResult;
  } catch {
    return null;
  }
}

export async function cleanupTaskFiles(workdir: string, taskId: string): Promise<void> {
  await Promise.all([
    fs.rm(taskFilePath(workdir, taskId), { force: true }),
    fs.rm(doneFilePath(workdir, taskId), { force: true }),
  ]);
}

export function instructionFilePath(workdir: string, taskId: string): string {
  return path.join(taskDir(workdir), `${taskId}.instruction`);
}

export async function writeInstructionFile(
  workdir: string,
  taskId: string,
  text: string,
): Promise<void> {
  const dir = taskDir(workdir);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(instructionFilePath(workdir, taskId), text, 'utf8');
}

export async function readAndClearInstructionFile(
  workdir: string,
  taskId: string,
): Promise<string | null> {
  const p = instructionFilePath(workdir, taskId);
  try {
    const text = await fs.readFile(p, 'utf8');
    await fs.rm(p, { force: true });
    return text;
  } catch {
    return null;
  }
}

export type DoneListener = (taskId: string, result: DoneResult) => void | Promise<void>;

export async function watchDoneFiles(
  workdir: string,
  listener: DoneListener,
): Promise<FSWatcher> {
  const dir = taskDir(workdir);
  await fs.mkdir(dir, { recursive: true });
  const seen = new Set<string>();
  const watcher = watch(dir, { persistent: false }, (_event, filename) => {
    if (filename === null) return;
    const name: string = typeof filename === 'string' ? filename : String(filename);
    if (!name.endsWith('.done')) return;
    const taskId = name.slice(0, -'.done'.length);
    if (seen.has(taskId)) return;
    setTimeout(() => {
      void (async () => {
        const result = await readDoneFile(workdir, taskId);
        if (result && !seen.has(taskId)) {
          seen.add(taskId);
          await listener(taskId, result);
        }
      })();
    }, 20);
  });
  return watcher;
}
