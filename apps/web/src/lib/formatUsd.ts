/**
 * Dollar amount for run costs: two decimals, with "<$0.01" for amounts too
 * small to show. Negative or non-finite values render as "$0.00".
 */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0.00";
  if (value < 0.01) return "<$0.01";
  return `$${value.toFixed(2)}`;
}
