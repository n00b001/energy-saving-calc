import { describe, it, expect } from 'vitest';
import { heatingDegrees, fmt } from './utils';

describe('utils', () => {
  it('heatingDegrees returns correct values', () => {
    expect(heatingDegrees(10)).toBe(5.5);
    expect(heatingDegrees(20)).toBe(0);
  });

  it('fmt formats currency correctly', () => {
    expect(fmt(1234)).toBe('£1,234');
    expect(fmt(-1234)).toBe('£1,234');
  });
});
