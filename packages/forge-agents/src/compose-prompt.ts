/**
 * System prompt composition for forge-lab agents.
 *
 * Layers multiple context sources into a single string that is passed
 * directly to an agent runtime. The layer order follows the vibe-forge
 * convention: personality body, project context, agent overrides, handoff
 * notes, and task context.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AgentPersonality } from './personality.js';

export interface ComposeInput {
  personality: AgentPersonality;
  projectContextPath?: string;
  agentOverridesDir?: string;
  handoffDir?: string;
  taskContext?: { taskId: string; title: string; description?: string | null };
}

/**
 * Compose a full system prompt from the given personality and optional
 * context layers.
 *
 * **Security note:** The composed prompt may contain sensitive content
 * (project context, handoff notes, task descriptions) and is passed
 * directly to the runtime. Callers are responsible for ensuring the
 * inputs are trustworthy.
 *
 * @param input - The personality and optional context sources.
 * @returns The composed prompt string.
 */
export async function composeSystemPrompt(input: ComposeInput): Promise<string> {
  const sections: string[] = [input.personality.systemPrompt];

  // --- Project Context ---
  if (input.projectContextPath !== undefined) {
    const ctx = await readProjectContext(input.projectContextPath);
    if (ctx !== null) {
      sections.push('---\n\n# Project Context\n\n' + ctx);
    }
  }

  // --- Agent Overrides ---
  if (input.agentOverridesDir !== undefined) {
    const overrides = await readFileIfExists(
      path.join(input.agentOverridesDir, `${input.personality.id}.md`),
    );
    if (overrides !== null) {
      sections.push(
        `---\n\n# Agent Overrides: ${input.personality.id}\n\n` + overrides,
      );
    }
  }

  // --- Handoff Notes ---
  if (input.handoffDir !== undefined) {
    const handoff = await readHandoffFiles(input.handoffDir, input.personality.id);
    if (handoff !== null) {
      sections.push('---\n\n# Handoff Notes\n\n' + handoff);
    }
  }

  // --- Task Context ---
  if (input.taskContext !== undefined) {
    let taskBlock = `Task ID: ${input.taskContext.taskId}\nTitle: ${input.taskContext.title}`;
    if (input.taskContext.description) {
      taskBlock += '\n\n' + input.taskContext.description;
    }
    sections.push('---\n\n# Current Task\n\n' + taskBlock);
  }

  return sections.join('\n\n');
}

/**
 * Read the project context file. Throws if the path exists but is not a
 * regular file (e.g. a directory). Returns null if the path does not exist.
 */
async function readProjectContext(filePath: string): Promise<string | null> {
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(filePath);
  } catch {
    // File does not exist; skip silently.
    return null;
  }
  if (!stat.isFile()) {
    throw new Error(
      `projectContextPath must point to a file, but "${filePath}" is not a regular file.`,
    );
  }
  const content = await fs.readFile(filePath, 'utf8');
  return content.trim() || null;
}

/**
 * Read a file if it exists. Returns null if the file is missing.
 */
async function readFileIfExists(filePath: string): Promise<string | null> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return content.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Read all handoff files matching `*-{personalityId}-*.md` in the given
 * directory. Files are sorted alphabetically by filename. Returns null if
 * the directory does not exist or no matching files are found.
 */
async function readHandoffFiles(
  dir: string,
  personalityId: string,
): Promise<string | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return null;
  }

  const pattern = new RegExp(`^.+-${escapeRegExp(personalityId)}-.+\\.md$`);
  const matching = entries.filter((name) => pattern.test(name)).sort();

  if (matching.length === 0) return null;

  const contents: string[] = [];
  for (const name of matching) {
    const raw = await fs.readFile(path.join(dir, name), 'utf8');
    const trimmed = raw.trim();
    if (trimmed) {
      contents.push(trimmed);
    }
  }

  return contents.length > 0 ? contents.join('\n\n') : null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
