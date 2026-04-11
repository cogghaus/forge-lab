/**
 * Built-in personality loader for @forge-lab/agents.
 *
 * Reads every `*.md` file in the `personalities/` directory that ships with
 * this package. Each file is expected to be YAML frontmatter (delimited by
 * `---` lines) followed by a Markdown body. The frontmatter maps to the
 * fields of `AgentPersonalitySchema` and the Markdown body becomes
 * `systemPrompt`.
 *
 * Path resolution uses `import.meta.url` so the loader works regardless of
 * the caller's current working directory. The `personalities/` directory
 * sits at `packages/forge-agents/personalities/`, one level above the
 * compiled module at `packages/forge-agents/dist/load-builtin.js` (and one
 * level above the source file at `src/load-builtin.ts` when vitest runs
 * against TypeScript sources directly). Both resolve to the same location.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import {
  AgentPersonalitySchema,
  type AgentPersonality,
  PersonalityRegistry,
} from './personality.js';

const FRONTMATTER_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/;

/**
 * Resolve the absolute path to the bundled personalities directory.
 * Exported for tests so they can assert the loader is pointing at the
 * expected location.
 */
export function builtinPersonalitiesDir(): string {
  const here = fileURLToPath(import.meta.url);
  // here is either `.../dist/load-builtin.js` (built) or
  // `.../src/load-builtin.ts` (vitest). In both cases the personalities
  // directory is one level up from the containing folder.
  return path.resolve(path.dirname(here), '..', 'personalities');
}

/**
 * Split a personality file's raw contents into frontmatter (parsed) and
 * Markdown body. Throws if the frontmatter delimiters are missing or the
 * YAML is invalid. The error message always identifies the file.
 */
function splitPersonalityFile(
  filename: string,
  raw: string,
): { frontmatter: Record<string, unknown>; body: string } {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) {
    throw new Error(
      `Failed to parse personality file ${filename}: missing or malformed YAML frontmatter (expected leading '---' block).`,
    );
  }
  const yamlText = match[1] ?? '';
  const body = (match[2] ?? '').trim();
  let frontmatter: unknown;
  try {
    frontmatter = parseYaml(yamlText);
  } catch (cause) {
    throw new Error(
      `Failed to parse personality file ${filename}: YAML frontmatter is invalid (${(cause as Error).message}).`,
      { cause },
    );
  }
  if (frontmatter === null || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
    throw new Error(
      `Failed to parse personality file ${filename}: frontmatter must be a YAML mapping.`,
    );
  }
  return { frontmatter: frontmatter as Record<string, unknown>, body };
}

/**
 * Load every personality file from a directory. Shared by the public
 * `loadBuiltinPersonalities()` and the tests (which point this at a
 * temporary directory for negative-case coverage).
 */
export async function loadPersonalitiesFromDir(
  dir: string,
): Promise<AgentPersonality[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (cause) {
    throw new Error(
      `Failed to read personalities directory ${dir}: ${(cause as Error).message}`,
      { cause },
    );
  }

  const files = entries.filter((name) => name.endsWith('.md')).sort();
  const personalities: AgentPersonality[] = [];
  const seenIds = new Set<string>();

  for (const name of files) {
    const full = path.join(dir, name);
    const raw = await fs.readFile(full, 'utf8');
    const { frontmatter, body } = splitPersonalityFile(name, raw);

    if (body.length === 0) {
      throw new Error(
        `Failed to parse personality file ${name}: Markdown body is empty (systemPrompt would be empty).`,
      );
    }

    let parsed: AgentPersonality;
    try {
      parsed = AgentPersonalitySchema.parse({
        ...frontmatter,
        systemPrompt: body,
      });
    } catch (cause) {
      throw new Error(
        `Failed to parse personality file ${name}: schema validation failed (${(cause as Error).message}).`,
        { cause },
      );
    }

    if (seenIds.has(parsed.id)) {
      throw new Error(
        `Failed to load personalities: duplicate id '${parsed.id}' found in ${name}.`,
      );
    }
    seenIds.add(parsed.id);
    personalities.push(parsed);
  }

  return personalities;
}

/**
 * Load the five built-in forge-lab personalities that ship with this
 * package. Returns them in filename-sorted order.
 */
export async function loadBuiltinPersonalities(): Promise<AgentPersonality[]> {
  return loadPersonalitiesFromDir(builtinPersonalitiesDir());
}

/**
 * Convenience helper: load the built-in personalities into a fresh
 * `PersonalityRegistry`. Useful for callers that want the map-style
 * lookup interface without constructing one themselves.
 */
export async function loadBuiltinRegistry(): Promise<PersonalityRegistry> {
  const reg = new PersonalityRegistry();
  for (const p of await loadBuiltinPersonalities()) {
    reg.register(p);
  }
  return reg;
}
