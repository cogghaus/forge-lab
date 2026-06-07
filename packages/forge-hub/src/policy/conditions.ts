import type { PolicyResource } from './engine.js';

export type ConditionField = 'resource.id' | 'resource.type';

export type ConditionExpr =
  | { op: 'eq'; field: ConditionField; value: string }
  | { op: 'in'; field: ConditionField; values: string[] }
  | { op: 'and'; conditions: ConditionExpr[] }
  | { op: 'or'; conditions: ConditionExpr[] }
  | { op: 'not'; condition: ConditionExpr };

const MAX_DEPTH = 5;
const MAX_LEAVES = 20;
const VALID_FIELDS: ConditionField[] = ['resource.id', 'resource.type'];

export function parseCondition(raw: string): ConditionExpr {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('resourceCondition must be valid JSON');
  }
  return parsed as ConditionExpr;
}

export function validateCondition(expr: unknown, depth = 0, leafCount = { n: 0 }): void {
  if (depth > MAX_DEPTH) throw new Error(`condition exceeds max depth ${MAX_DEPTH}`);
  if (typeof expr !== 'object' || expr === null || Array.isArray(expr)) {
    throw new Error('condition must be a JSON object');
  }
  const e = expr as Record<string, unknown>;
  const op = e['op'];
  if (typeof op !== 'string') throw new Error('condition missing string "op"');

  if (op === 'eq' || op === 'in') {
    leafCount.n++;
    if (leafCount.n > MAX_LEAVES) throw new Error(`condition exceeds max ${MAX_LEAVES} leaf nodes`);
    const field = e['field'];
    if (!VALID_FIELDS.includes(field as ConditionField)) {
      throw new Error(`invalid field "${String(field)}"; allowed: ${VALID_FIELDS.join(', ')}`);
    }
    if (op === 'eq') {
      if (typeof e['value'] !== 'string') throw new Error('"eq" requires string "value"');
    } else {
      if (!Array.isArray(e['values']) || e['values'].some((v) => typeof v !== 'string')) {
        throw new Error('"in" requires string[] "values"');
      }
      if ((e['values'] as unknown[]).length === 0) throw new Error('"in" values must not be empty');
      if ((e['values'] as unknown[]).length > MAX_LEAVES)
        throw new Error(`"in" values must not exceed ${MAX_LEAVES} items`);
    }
  } else if (op === 'and' || op === 'or') {
    const conditions = e['conditions'];
    if (!Array.isArray(conditions) || conditions.length === 0) {
      throw new Error(`"${op}" requires non-empty "conditions" array`);
    }
    for (const child of conditions) validateCondition(child, depth + 1, leafCount);
  } else if (op === 'not') {
    if (typeof e['condition'] !== 'object' || e['condition'] === null) {
      throw new Error('"not" requires a "condition" object');
    }
    validateCondition(e['condition'], depth + 1, leafCount);
  } else {
    throw new Error(`unknown op "${op}"`);
  }
}

function resolveField(field: ConditionField, resource: PolicyResource): string | undefined {
  if (field === 'resource.id') return resource.id;
  if (field === 'resource.type') return resource.type;
}

export function evalCondition(expr: ConditionExpr, resource: PolicyResource): boolean {
  switch (expr.op) {
    case 'eq': {
      const val = resolveField(expr.field, resource);
      return val !== undefined && val === expr.value;
    }
    case 'in': {
      const val = resolveField(expr.field, resource);
      return val !== undefined && expr.values.includes(val);
    }
    case 'and':
      return expr.conditions.every((c) => evalCondition(c, resource));
    case 'or':
      return expr.conditions.some((c) => evalCondition(c, resource));
    case 'not':
      return !evalCondition(expr.condition, resource);
  }
}
