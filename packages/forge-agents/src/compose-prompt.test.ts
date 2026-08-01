import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { composeSystemPrompt } from './compose-prompt.js';
import type { AgentPersonality } from './personality.js';
import { loadBuiltinRegistry } from './load-builtin.js';

function makePersonality(overrides: Partial<AgentPersonality> = {}): AgentPersonality {
  return {
    id: 'test-agent',
    name: 'Test Agent',
    description: 'A test personality',
    systemPrompt: 'You are the test agent.',
    tags: [],
    preferredTools: [],
    runtimeHints: {},
    ...overrides,
  };
}

describe('composeSystemPrompt', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'compose-prompt-'));
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('personality-only returns body with no extra delimiters', async () => {
    const result = await composeSystemPrompt({
      personality: makePersonality(),
    });
    expect(result).toBe('You are the test agent.');
    expect(result).not.toContain('---');
  });

  it('all four layers present produces correct order and delimiter headings', async () => {
    // Set up files
    const projectCtx = path.join(tmpDir, 'project-ctx-all.md');
    await fs.writeFile(projectCtx, 'Project info here', 'utf8');

    const overridesDir = path.join(tmpDir, 'overrides-all');
    await fs.mkdir(overridesDir, { recursive: true });
    await fs.writeFile(
      path.join(overridesDir, 'test-agent.md'),
      'Override content for test-agent',
      'utf8',
    );

    const handoffDir = path.join(tmpDir, 'handoffs-all');
    await fs.mkdir(handoffDir, { recursive: true });
    await fs.writeFile(
      path.join(handoffDir, 'alpha-test-agent-notes.md'),
      'Handoff from alpha',
      'utf8',
    );

    const result = await composeSystemPrompt({
      personality: makePersonality(),
      projectContextPath: projectCtx,
      agentOverridesDir: overridesDir,
      handoffDir,
      taskContext: { taskId: 'fl-042', title: 'Build the thing', description: 'Detailed desc' },
    });

    // Verify layer order via indexOf
    const bodyIdx = result.indexOf('You are the test agent.');
    const projIdx = result.indexOf('# Project Context');
    const overIdx = result.indexOf('# Agent Overrides: test-agent');
    const handIdx = result.indexOf('# Handoff Notes');
    const taskIdx = result.indexOf('# Current Task');

    expect(bodyIdx).toBeGreaterThanOrEqual(0);
    expect(projIdx).toBeGreaterThan(bodyIdx);
    expect(overIdx).toBeGreaterThan(projIdx);
    expect(handIdx).toBeGreaterThan(overIdx);
    expect(taskIdx).toBeGreaterThan(handIdx);

    expect(result).toContain('Project info here');
    expect(result).toContain('Override content for test-agent');
    expect(result).toContain('Handoff from alpha');
    expect(result).toContain('Task ID: fl-042');
    expect(result).toContain('Title: Build the thing');
    expect(result).toContain('Detailed desc');
  });

  it('missing project-context path is skipped silently', async () => {
    const result = await composeSystemPrompt({
      personality: makePersonality(),
      projectContextPath: path.join(tmpDir, 'does-not-exist.md'),
    });
    expect(result).toBe('You are the test agent.');
    expect(result).not.toContain('Project Context');
  });

  it('missing agent-overrides file is skipped silently', async () => {
    const emptyDir = path.join(tmpDir, 'empty-overrides');
    await fs.mkdir(emptyDir, { recursive: true });

    const result = await composeSystemPrompt({
      personality: makePersonality(),
      agentOverridesDir: emptyDir,
    });
    expect(result).toBe('You are the test agent.');
    expect(result).not.toContain('Agent Overrides');
  });

  it('missing handoff directory is skipped silently', async () => {
    const result = await composeSystemPrompt({
      personality: makePersonality(),
      handoffDir: path.join(tmpDir, 'no-such-handoff-dir'),
    });
    expect(result).toBe('You are the test agent.');
    expect(result).not.toContain('Handoff Notes');
  });

  it('non-file projectContextPath throws a clear error identifying the path', async () => {
    const dirPath = path.join(tmpDir, 'a-directory');
    await fs.mkdir(dirPath, { recursive: true });

    await expect(
      composeSystemPrompt({
        personality: makePersonality(),
        projectContextPath: dirPath,
      }),
    ).rejects.toThrow(dirPath);
  });

  it('taskContext is rendered correctly when present', async () => {
    const result = await composeSystemPrompt({
      personality: makePersonality(),
      taskContext: { taskId: 'fl-001', title: 'My Task', description: 'Do something' },
    });
    expect(result).toContain('# Current Task');
    expect(result).toContain('Task ID: fl-001');
    expect(result).toContain('Title: My Task');
    expect(result).toContain('Do something');
  });

  it('taskContext without description omits description block', async () => {
    const result = await composeSystemPrompt({
      personality: makePersonality(),
      taskContext: { taskId: 'fl-002', title: 'No Desc' },
    });
    expect(result).toContain('Task ID: fl-002');
    expect(result).toContain('Title: No Desc');
    // The text after the title line should end without extra content
    const taskSection = result.slice(result.indexOf('Task ID:'));
    const lines = taskSection.split('\n').map((l) => l.trim()).filter(Boolean);
    expect(lines).toEqual(['Task ID: fl-002', 'Title: No Desc']);
  });

  it('agent overrides lookup uses personality.id', async () => {
    const overridesDir = path.join(tmpDir, 'overrides-id-check');
    await fs.mkdir(overridesDir, { recursive: true });
    await fs.writeFile(
      path.join(overridesDir, 'custom-id.md'),
      'Override for custom-id',
      'utf8',
    );
    // Also write a file for a different id to prove we pick the right one
    await fs.writeFile(
      path.join(overridesDir, 'other-id.md'),
      'Override for other-id',
      'utf8',
    );

    const result = await composeSystemPrompt({
      personality: makePersonality({ id: 'custom-id' }),
      agentOverridesDir: overridesDir,
    });
    expect(result).toContain('Override for custom-id');
    expect(result).not.toContain('Override for other-id');
    expect(result).toContain('# Agent Overrides: custom-id');
  });

  it('handoff files are sorted deterministically by filename', async () => {
    const handoffDir = path.join(tmpDir, 'handoffs-sorted');
    await fs.mkdir(handoffDir, { recursive: true });
    await fs.writeFile(
      path.join(handoffDir, 'charlie-test-agent-handoff.md'),
      'From Charlie',
      'utf8',
    );
    await fs.writeFile(
      path.join(handoffDir, 'alpha-test-agent-handoff.md'),
      'From Alpha',
      'utf8',
    );
    await fs.writeFile(
      path.join(handoffDir, 'bravo-test-agent-handoff.md'),
      'From Bravo',
      'utf8',
    );
    // This file should NOT match (different personality id)
    await fs.writeFile(
      path.join(handoffDir, 'alpha-other-agent-handoff.md'),
      'Should not appear',
      'utf8',
    );

    const result = await composeSystemPrompt({
      personality: makePersonality(),
      handoffDir,
    });
    expect(result).toContain('# Handoff Notes');
    expect(result).not.toContain('Should not appear');

    const alphaIdx = result.indexOf('From Alpha');
    const bravoIdx = result.indexOf('From Bravo');
    const charlieIdx = result.indexOf('From Charlie');
    expect(alphaIdx).toBeGreaterThanOrEqual(0);
    expect(bravoIdx).toBeGreaterThan(alphaIdx);
    expect(charlieIdx).toBeGreaterThan(bravoIdx);
  });

  it('end-to-end: loadBuiltinRegistry + compose with a project context file', async () => {
    const registry = await loadBuiltinRegistry();
    const architect = registry.get('architect');
    expect(architect).not.toBeNull();

    // Use a fixture rather than this repo's own context/project-context.md.
    // A consumer supplies their own project context; forge-lab's happens to be
    // private, and a test that reads a live maintainer document is brittle
    // besides. This exercises the same composition path.
    const projectContextPath = path.join(tmpDir, 'e2e-project-context.md');
    await fs.writeFile(
      projectContextPath,
      '# Project Context\n\nforge-lab: multi-agent orchestration for AI-assisted development.\n',
      'utf8',
    );

    const result = await composeSystemPrompt({
      personality: architect!,
      projectContextPath,
    });

    expect(result.length).toBeGreaterThan(0);
    // Should contain architect personality content
    expect(result).toContain(architect!.systemPrompt.slice(0, 40));
    // Should contain a marker from the project context
    expect(result).toContain('forge-lab');
    expect(result).toContain('# Project Context');
  });
});
