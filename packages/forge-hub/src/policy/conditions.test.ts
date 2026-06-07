import { describe, it, expect } from 'vitest';
import { parseCondition, validateCondition, evalCondition, type ConditionExpr } from './conditions.js';
import type { PolicyResource } from './engine.js';

const resource = (type: string, id?: string): PolicyResource =>
  ({ type: type as PolicyResource['type'], id }) as PolicyResource;

describe('parseCondition', () => {
  it('parses valid JSON object', () => {
    const expr = parseCondition('{"op":"eq","field":"resource.id","value":"abc"}');
    expect(expr).toMatchObject({ op: 'eq', field: 'resource.id', value: 'abc' });
  });

  it('throws on invalid JSON', () => {
    expect(() => parseCondition('not json')).toThrow('valid JSON');
  });
});

describe('validateCondition', () => {
  it('accepts eq with resource.id', () => {
    expect(() =>
      validateCondition({ op: 'eq', field: 'resource.id', value: 'abc' }),
    ).not.toThrow();
  });

  it('accepts in with resource.type', () => {
    expect(() =>
      validateCondition({ op: 'in', field: 'resource.type', values: ['task', 'doc'] }),
    ).not.toThrow();
  });

  it('accepts nested and/or/not', () => {
    const expr: ConditionExpr = {
      op: 'and',
      conditions: [
        { op: 'eq', field: 'resource.id', value: 'x' },
        { op: 'not', condition: { op: 'in', field: 'resource.type', values: ['doc'] } },
      ],
    };
    expect(() => validateCondition(expr)).not.toThrow();
  });

  it('rejects unknown op', () => {
    expect(() => validateCondition({ op: 'regex', field: 'resource.id', value: '.*' } as unknown as ConditionExpr)).toThrow('unknown op');
  });

  it('rejects unknown field', () => {
    expect(() =>
      validateCondition({ op: 'eq', field: 'resource.owner' as never, value: 'x' }),
    ).toThrow('invalid field');
  });

  it('rejects in with empty values', () => {
    expect(() =>
      validateCondition({ op: 'in', field: 'resource.id', values: [] }),
    ).toThrow('must not be empty');
  });

  it('rejects depth > 5', () => {
    const deep = (d: number): ConditionExpr =>
      d === 0
        ? { op: 'eq', field: 'resource.id', value: 'x' }
        : { op: 'and', conditions: [deep(d - 1)] };
    expect(() => validateCondition(deep(6))).toThrow('max depth');
  });

  it('rejects > 20 leaf nodes', () => {
    const manyLeaves: ConditionExpr = {
      op: 'or',
      conditions: Array.from({ length: 21 }, (_, i) => ({
        op: 'eq' as const,
        field: 'resource.id' as const,
        value: String(i),
      })),
    };
    expect(() => validateCondition(manyLeaves)).toThrow('max 20');
  });

  it('rejects and with empty conditions', () => {
    expect(() => validateCondition({ op: 'and', conditions: [] })).toThrow('non-empty');
  });
});

describe('evalCondition', () => {
  it('eq matches matching resource.id', () => {
    expect(evalCondition({ op: 'eq', field: 'resource.id', value: 'abc' }, resource('task', 'abc'))).toBe(true);
  });

  it('eq fails on non-matching id', () => {
    expect(evalCondition({ op: 'eq', field: 'resource.id', value: 'abc' }, resource('task', 'xyz'))).toBe(false);
  });

  it('eq fails when id is absent', () => {
    expect(evalCondition({ op: 'eq', field: 'resource.id', value: 'abc' }, resource('task'))).toBe(false);
  });

  it('in matches when value in list', () => {
    expect(evalCondition({ op: 'in', field: 'resource.type', values: ['task', 'doc'] }, resource('task', 'x'))).toBe(true);
  });

  it('in fails when value not in list', () => {
    expect(evalCondition({ op: 'in', field: 'resource.type', values: ['doc'] }, resource('task', 'x'))).toBe(false);
  });

  it('and: both true → true', () => {
    const expr: ConditionExpr = {
      op: 'and',
      conditions: [
        { op: 'eq', field: 'resource.id', value: 'x' },
        { op: 'eq', field: 'resource.type', value: 'task' },
      ],
    };
    expect(evalCondition(expr, resource('task', 'x'))).toBe(true);
  });

  it('and: one false → false', () => {
    const expr: ConditionExpr = {
      op: 'and',
      conditions: [
        { op: 'eq', field: 'resource.id', value: 'x' },
        { op: 'eq', field: 'resource.type', value: 'doc' },
      ],
    };
    expect(evalCondition(expr, resource('task', 'x'))).toBe(false);
  });

  it('or: one true → true', () => {
    const expr: ConditionExpr = {
      op: 'or',
      conditions: [
        { op: 'eq', field: 'resource.id', value: 'nope' },
        { op: 'eq', field: 'resource.type', value: 'task' },
      ],
    };
    expect(evalCondition(expr, resource('task', 'x'))).toBe(true);
  });

  it('not inverts result', () => {
    const expr: ConditionExpr = {
      op: 'not',
      condition: { op: 'eq', field: 'resource.type', value: 'doc' },
    };
    expect(evalCondition(expr, resource('task', 'x'))).toBe(true);
    expect(evalCondition(expr, resource('doc', 'x'))).toBe(false);
  });
});
