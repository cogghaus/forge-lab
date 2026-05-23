import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  taskDir,
  instructionFilePath,
  writeInstructionFile,
  readAndClearInstructionFile,
} from './task-file.js';

describe('instruction file helpers', () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-tf-'));
  });

  afterEach(async () => {
    await fs.rm(workdir, { recursive: true, force: true });
  });

  it('instructionFilePath uses .instruction extension', () => {
    const p = instructionFilePath('/base', 'fl-001');
    expect(path.basename(p)).toBe('fl-001.instruction');
    expect(p).toContain(path.join('.forge', 'tasks'));
  });

  it('writeInstructionFile creates the tasks dir if missing', async () => {
    await writeInstructionFile(workdir, 'fl-001', 'summarize and stop');
    const p = instructionFilePath(workdir, 'fl-001');
    const content = await fs.readFile(p, 'utf8');
    expect(content).toBe('summarize and stop');
  });

  it('readAndClearInstructionFile returns content and deletes the file', async () => {
    await fs.mkdir(taskDir(workdir), { recursive: true });
    await writeInstructionFile(workdir, 'fl-002', 'new instruction');

    const result = await readAndClearInstructionFile(workdir, 'fl-002');
    expect(result).toBe('new instruction');

    await expect(fs.access(instructionFilePath(workdir, 'fl-002'))).rejects.toThrow();
  });

  it('readAndClearInstructionFile returns null when file absent', async () => {
    const result = await readAndClearInstructionFile(workdir, 'fl-999');
    expect(result).toBeNull();
  });

  it('overwrites existing instruction file on second write', async () => {
    await writeInstructionFile(workdir, 'fl-003', 'first');
    await writeInstructionFile(workdir, 'fl-003', 'second');
    const result = await readAndClearInstructionFile(workdir, 'fl-003');
    expect(result).toBe('second');
  });
});
