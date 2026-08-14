import { describe, it, expect } from 'vitest';
import { pop } from '../set-utils';

describe('pop', () => {
  it('removes and returns first item from set with single element', () => {
    const set = new Set(['single']);
    const result = pop(set);

    expect(result).toBe('single');
    expect(set.size).toBe(0);
    expect(set.has('single')).toBe(false);
  });

  it('removes and returns first item from set with multiple elements', () => {
    const set = new Set(['first', 'second', 'third']);
    const result = pop(set);

    expect(result).toBe('first');
    expect(set.size).toBe(2);
    expect(set.has('first')).toBe(false);
    expect(set.has('second')).toBe(true);
    expect(set.has('third')).toBe(true);
  });

  it('returns undefined for empty set', () => {
    const emptySet = new Set<string>();
    const result = pop(emptySet);

    expect(result).toBeUndefined();
    expect(emptySet.size).toBe(0);
  });

  it('works with different data types', () => {
    const numberSet = new Set([42, 100, 7]);
    const booleanSet = new Set([true, false]);
    const objectSet = new Set([{ id: 1 }, { id: 2 }]);

    expect(typeof pop(numberSet)).toBe('number');
    expect(typeof pop(booleanSet)).toBe('boolean');
    expect(typeof pop(objectSet)).toBe('object');
  });

  it('maintains set iteration order', () => {
    const set = new Set(['a', 'b', 'c']);
    const results: (string | undefined)[] = [];

    // Pop all elements and verify order
    while (set.size > 0) {
      results.push(pop(set));
    }

    expect(results).toEqual(['a', 'b', 'c']);
  });

  it('handles repeated pops on same set', () => {
    const set = new Set([1, 2]);

    const first = pop(set);
    const second = pop(set);
    const third = pop(set);

    expect(first).toBe(1);
    expect(second).toBe(2);
    expect(third).toBeUndefined();
    expect(set.size).toBe(0);
  });

  it('does not modify original set reference', () => {
    const originalSet = new Set(['test']);
    const setReference = originalSet;

    pop(originalSet);

    expect(setReference).toBe(originalSet);
    expect(setReference.size).toBe(0);
  });

  it('works with Set containing falsy values', () => {
    const set = new Set([0, '', false, null]);
    const results: (string | number | boolean | null | undefined)[] = [];

    while (set.size > 0) {
      results.push(pop(set));
    }

    expect(results).toHaveLength(4);
    expect(results).toContain(0);
    expect(results).toContain('');
    expect(results).toContain(false);
    expect(results).toContain(null);
  });
});
