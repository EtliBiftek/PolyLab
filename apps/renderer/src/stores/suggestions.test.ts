import { beforeEach, describe, expect, it } from "vitest";

import { SUGGESTION_POOLS, useSuggestions } from "./suggestions";

describe("suggestions store", () => {
  beforeEach(() => {
    useSuggestions.setState({ current: [], lastByMode: {} });
  });

  it("returns exactly 3 suggestions", () => {
    useSuggestions.getState().refresh("chat", "tr", "seed-1");
    expect(useSuggestions.getState().current).toHaveLength(3);
  });

  it("changes between chat and coding modes", () => {
    useSuggestions.getState().refresh("chat", "en", "seed");
    const chat = [...useSuggestions.getState().current];
    useSuggestions.getState().refresh("coding", "en", "seed");
    const coding = useSuggestions.getState().current;
    expect(chat).not.toEqual(coding);
    for (const item of coding) {
      expect(SUGGESTION_POOLS.en.coding).toContain(item);
    }
  });

  it("never repeats the previous set for the same mode", () => {
    const seen: string[][] = [];
    for (let i = 0; i < 6; i += 1) {
      useSuggestions.getState().refresh("chat", "tr", `seed-${i}`);
      const current = [...useSuggestions.getState().current];
      const previous = seen[seen.length - 1];
      if (previous != null) {
        expect(current).not.toEqual(previous);
      }
      seen.push(current);
    }
    // All items come from the pool.
    for (const set of seen) {
      for (const item of set) expect(SUGGESTION_POOLS.tr.chat).toContain(item);
    }
  });
});
