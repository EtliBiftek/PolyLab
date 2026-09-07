import { create } from "zustand";

import { getCostStats, type CostStats } from "../lib/api";

interface CostState {
  stats: CostStats | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export const useCost = create<CostState>((set) => ({
  stats: null,
  loading: false,
  error: null,
  refresh: async () => {
    set({ loading: true, error: null });
    try {
      const stats = await getCostStats();
      set({ stats, loading: false });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error), loading: false });
    }
  },
}));

/** USD of the current month (first row) from the latest stats. */
export function currentMonthUsd(stats: CostStats | null): number | null {
  const current = new Date().toISOString().slice(0, 7);
  const row = stats?.months.find((month) => month.month === current);
  return row != null ? row.usd : stats?.months[0]?.usd ?? null;
}
