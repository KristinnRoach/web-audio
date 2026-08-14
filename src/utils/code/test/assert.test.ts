import { describe, it, expect } from 'vitest';
import { assert } from '../assert';

describe('assert', () => {
  it('passes when condition is true', () => {
    expect(() => assert(true)).not.toThrow();
  });

  it('throws when condition is false', () => {
    expect(() => assert(false)).toThrow('Assertion failed');
  });

  it('includes custom message in error', () => {
    const message = 'Custom error message';
    expect(() => assert(false, message)).toThrow(
      `Assertion failed: ${message}`
    );
  });

  it('includes context in error when provided', () => {
    const context = { foo: 'bar' };
    expect(() => assert(false, 'Failed', context)).toThrow(
      `Assertion failed: Failed\nContext: ${JSON.stringify(context)}`
    );
  });

  it('handles falsy values correctly', () => {
    expect(() => assert(0)).toThrow();
    expect(() => assert('')).toThrow();
    expect(() => assert(null)).toThrow();
    expect(() => assert(undefined)).toThrow();
  });

  // Type checking test
  it('narrows type after successful assertion', () => {
    const value: string | null = 'test';
    assert(value !== null, 'Value should not be null');
    // TypeScript should now know that value is string
    expect(value.length).toBeGreaterThan(0);
  });
});
