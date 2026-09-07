import { describe, expect, it } from 'vitest';
import { estimateCostUsd, formatCostUsd } from './cost';

describe('estimateCostUsd', () => {
  it('computes input and output cost from per-1M prices', () => {
    expect(estimateCostUsd(1_000_000, 2_000_000, 3, 15)).toBeCloseTo(33, 10);
  });

  it('returns null when no price is configured', () => {
    expect(estimateCostUsd(100, 100, null, null)).toBeNull();
  });

  it('uses the configured side even when the other is missing', () => {
    expect(estimateCostUsd(1_000_000, null, 2, null)).toBeCloseTo(2, 10);
    expect(estimateCostUsd(null, 1_000_000, null, 5)).toBeCloseTo(5, 10);
  });

  it('returns null for zero-token zero-price cost', () => {
    expect(estimateCostUsd(0, 0, 1, 1)).toBeNull();
  });
});

describe('formatCostUsd', () => {
  it('formats ranges of magnitudes', () => {
    expect(formatCostUsd(1.5)).toBe('$1.50');
    expect(formatCostUsd(0.05)).toBe('$0.050');
    expect(formatCostUsd(0.0005)).toBe('$0.00050');
    expect(formatCostUsd(0.000001)).toBe('<$0.00001');
  });
});
