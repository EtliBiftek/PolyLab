/** Pure cost helpers: USD figures from token counts + per-1M-token prices. */

/** Estimated cost in USD; null when no price is configured. */
export function estimateCostUsd(
  tokensIn: number | null,
  tokensOut: number | null,
  priceIn: number | null,
  priceOut: number | null,
): number | null {
  if (priceIn == null && priceOut == null) return null;
  const input = ((tokensIn ?? 0) * (priceIn ?? 0)) / 1_000_000;
  const output = ((tokensOut ?? 0) * (priceOut ?? 0)) / 1_000_000;
  const total = input + output;
  return total > 0 ? total : null;
}

/** Formats a USD amount compactly (small values keep meaningful digits). */
export function formatCostUsd(usd: number): string {
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(3)}`;
  if (usd >= 0.0001) return `$${usd.toFixed(5)}`;
  return `<$0.00001`;
}
