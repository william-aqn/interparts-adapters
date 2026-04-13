import { describe, it, expect } from 'vitest';
import adapter from './adapter.js';

describe('stub adapter', () => {
  it('has capabilities', () => {
    expect(adapter.capabilities.mode).toBe('http');
  });
});
