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

export interface DoneResult {
  result?: string;
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
