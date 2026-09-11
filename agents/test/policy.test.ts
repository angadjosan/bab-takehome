import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SpendingLimitError, SpendingPolicy } from '../src/buyer/policy.ts';
import { tmpDir } from './fixture.ts';

describe('buyer spending policy', () => {
  const fresh = () => new SpendingPolicy(path.join(tmpDir('policy-'), 'policy.json'));

  it('refuses any spend before a budget is configured', () => {
    expect(() => fresh().authorize(1n)).toThrow(SpendingLimitError);
  });

  it('enforces max price per purchase', () => {
    const p = fresh();
    p.setBudget(1_000n);
    expect(() => p.authorize(101n, { maxPrice: 100n })).toThrow(/max price/);
    expect(() => p.authorize(100n, { maxPrice: 100n })).not.toThrow();
  });

  it('enforces the cumulative budget across purchases and bonds, persisted on disk', () => {
    const file = path.join(tmpDir('policy-'), 'policy.json');
    const p = new SpendingPolicy(file);
    p.setBudget(250n);
    p.record({ kind: 'purchase', ref: '1', amount: 100n });
    p.record({ kind: 'bond', ref: '1', amount: 50n });
    // a new process sees the persisted spent total
    const q = new SpendingPolicy(file);
    expect(q.spent()).toBe(150n);
    expect(q.remaining()).toBe(100n);
    expect(() => q.authorize(101n)).toThrow(/exceed budget/);
    q.authorize(100n);
    q.record({ kind: 'purchase', ref: '2', amount: 100n });
    expect(() => q.authorize(1n)).toThrow(/exceed budget/);
    expect(q.remaining()).toBe(0n);
  });

  it('never double-records the same purchase and rejects non-positive amounts', () => {
    const p = fresh();
    p.setBudget(1_000n);
    p.record({ kind: 'purchase', ref: '7', amount: 10n });
    expect(() => p.record({ kind: 'purchase', ref: '7', amount: 10n })).toThrow(/already recorded/);
    expect(() => p.authorize(0n)).toThrow();
  });

  it('lowering the budget below spent blocks further spend', () => {
    const p = fresh();
    p.setBudget(100n);
    p.record({ kind: 'purchase', ref: '1', amount: 80n });
    p.setBudget(50n);
    expect(p.remaining()).toBe(0n);
    expect(() => p.authorize(1n)).toThrow();
  });
});
