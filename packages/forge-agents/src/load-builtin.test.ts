import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  loadBuiltinPersonalities,
  loadBuiltinRegistry,
  loadPersonalitiesFromDir,
  builtinPersonalitiesDir,
} from './load-builtin.js';
import { PersonalityRegistry } from './personality.js';

const EXPECTED_IDS = ['aegis', 'architect', 'crucible', 'forge-master', 'herald', 'loki', 'oracle', 'scribe', 'temper'];

describe('loadBuiltinPersonalities', () => {
  it('resolves to the packaged personalities directory', async () => {
    const dir = builtinPersonalitiesDir();
    const stat = await fs.stat(dir);
    expect(stat.isDirectory()).toBe(true);
  });

  it('returns exactly nine entries', async () => {
    const all = await loadBuiltinPersonalities();
    expect(all).toHaveLength(9);
  });

  it('includes every expected id exactly once', async () => {
    const all = await loadBuiltinPersonalities();
    const ids = all.map((p) => p.id).sort();
    expect(ids).toEqual(EXPECTED_IDS);
  });

  it('gives every personality a non-empty system prompt of at least 100 characters', async () => {
    const all = await loadBuiltinPersonalities();
    for (const p of all) {
      expect(p.systemPrompt.length).toBeGreaterThanOrEqual(100);
    }
  });

  it('populates a PersonalityRegistry with correct lookups', async () => {
    const reg = await loadBuiltinRegistry();
    expect(reg).toBeInstanceOf(PersonalityRegistry);
    expect(reg.list()).toHaveLength(9);
    for (const id of EXPECTED_IDS) {
      expect(reg.has(id)).toBe(true);
      expect(reg.get(id)?.id).toBe(id);
    }
    expect(reg.get('does-not-exist')).toBeNull();
  });

  it('parses every file through the schema without mutation side effects', async () => {
    const first = await loadBuiltinPersonalities();
    const second = await loadBuiltinPersonalities();
    expect(second.map((p) => p.id).sort()).toEqual(
      first.map((p) => p.id).sort(),
    );
  });
});

describe('loadPersonalitiesFromDir (negative cases)', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-agents-test-'));
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('throws an error identifying the filename when frontmatter is missing', async () => {
    const dir = await fs.mkdtemp(path.join(tmpDir, 'missing-fm-'));
    const filename = 'broken.md';
    await fs.writeFile(
      path.join(dir, filename),
      '# Just markdown, no frontmatter at all\n',
      'utf8',
    );
    await expect(loadPersonalitiesFromDir(dir)).rejects.toThrow(filename);
  });

  it('throws an error identifying the filename when required schema fields are missing', async () => {
    const dir = await fs.mkdtemp(path.join(tmpDir, 'missing-id-'));
    const filename = 'no-id.md';
    await fs.writeFile(
      path.join(dir, filename),
      '---\nname: Only Name\n---\nSome body content here that is long enough to count.\n',
      'utf8',
    );
    await expect(loadPersonalitiesFromDir(dir)).rejects.toThrow(filename);
  });

  it('throws an error identifying the filename when the Markdown body is empty', async () => {
    const dir = await fs.mkdtemp(path.join(tmpDir, 'empty-body-'));
    const filename = 'no-body.md';
    await fs.writeFile(
      path.join(dir, filename),
      '---\nid: x\nname: X\n---\n',
      'utf8',
    );
    await expect(loadPersonalitiesFromDir(dir)).rejects.toThrow(filename);
  });

  it('throws when two files declare the same id', async () => {
    const dir = await fs.mkdtemp(path.join(tmpDir, 'dup-id-'));
    const body = 'Long enough body for the schema to accept it as a system prompt value.';
    await fs.writeFile(
      path.join(dir, 'a.md'),
      `---\nid: shared\nname: A\n---\n${body}\n`,
      'utf8',
    );
    await fs.writeFile(
      path.join(dir, 'b.md'),
      `---\nid: shared\nname: B\n---\n${body}\n`,
      'utf8',
    );
    await expect(loadPersonalitiesFromDir(dir)).rejects.toThrow(/duplicate id 'shared'/);
  });

  it('returns an empty array for a directory with no markdown files', async () => {
    const dir = await fs.mkdtemp(path.join(tmpDir, 'empty-'));
    const out = await loadPersonalitiesFromDir(dir);
    expect(out).toEqual([]);
  });
});
