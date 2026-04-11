#!/usr/bin/env node
// License scanner for the forge-lab public (MIT) monorepo.
// Fails if any source file in packages/ references a proprietary dependency
// that must never ship in the public repo (e.g. Magic UI Pro).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

const FORBIDDEN_NEEDLES = [
  '@magicui/pro',
  'magicui-pro',
  'magic-ui-pro',
  '@magic-ui/pro',
];

const IGNORE_DIRS = new Set([
  'node_modules',
  'dist',
  '.turbo',
  '.git',
  'coverage',
  '.next',
]);

const SOURCE_EXTS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
]);

const ALLOW_SELF_REFERENCE = new Set([
  'scripts/check-license.mjs',
]);

const root = process.cwd();
const offenders = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (IGNORE_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      walk(full);
      continue;
    }
    const ext = extname(entry);
    if (!SOURCE_EXTS.has(ext)) continue;
    const rel = relative(root, full).replace(/\\/g, '/');
    if (ALLOW_SELF_REFERENCE.has(rel)) continue;
    const content = readFileSync(full, 'utf8');
    for (const needle of FORBIDDEN_NEEDLES) {
      if (content.includes(needle)) {
        offenders.push({ file: rel, needle });
      }
    }
  }
}

walk(root);

if (offenders.length > 0) {
  console.error('License scanner: forbidden proprietary references found:');
  for (const o of offenders) {
    console.error(`  ${o.file}: ${o.needle}`);
  }
  console.error('');
  console.error('The forge-lab public repo is MIT-licensed and must not bundle');
  console.error('or reference Magic UI Pro. Move offending code to forge-dash-pro.');
  process.exit(1);
}

console.log('License scanner: OK');
