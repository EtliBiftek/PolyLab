import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import i18n from "../../i18n";
import type { Message, Model } from "../../lib/api";
import type { StreamingMessage } from "../../stores/chat";
import { RaceGroup, RaceStreamGrid } from "./RaceView";

const model = (id: string, display_name: string): Model => ({
  id,
  provider_id: "p",
  model_id: id,
  display_name,
  color: null,
  temperature: null,
  max_tokens: null,
  system_prompt_override: null,
  supports_vision: false,
  supports_tools: false,
  supports_reasoning: false,
  reasoning_enabled: null,
  reasoning_options: null,
  reasoning_effort: null,
  price_input: 3,
  price_output: 15,
  enabled: true,
  provider_kind: "openai_compat",
  provider_name: "Test",
});

const models = [model("m1", "Alpha"), model("m2", "Beta")];

const raceMessage = (id: string, modelId: string, content: string): Message => ({
  id,
  conversation_id: "c1",
  role: "assistant",
  content,
  reasoning: null,
  model_id: modelId,
  resolved_model: null,
  has_debate: null,
  tokens_in: 1_000_000,
  tokens_out: 1_000_000,
  tokens_estimated: false,
  attachments_json: null,
  feedback: null,
  race_id: "race-1",
  fallback_from_model_id: null,
  created_at: "2026-09-07T00:00:00Z",
});

const stream = (id: string, modelId: string, content: string): StreamingMessage => ({
  id,
  conversationId: "c1",
  modelId,
  mode: "race",
  content,
  reasoning: "",
  status: "streaming",
  resolvedModel: null,
  usage: null,
  errorDetail: null,
  raceId: "race-2",
  fallback: null,
  debate: [],
  agentSteps: [],
});

describe("race UI", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    await i18n.init();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders persisted race answers as side-by-side model columns with usage and cost", async () => {
    await act(async () => {
      root.render(
        <RaceGroup
          messages={[
            raceMessage("r1", "m1", "Alpha answer"),
            raceMessage("r2", "m2", "Beta answer"),
          ]}
          models={models}
        />,
      );
    });
    const group = container.querySelector('[data-testid="race-group"]');
    expect(group).not.toBeNull();
    const text = group!.textContent ?? "";
    expect(text).toContain("Alpha");
    expect(text).toContain("Alpha answer");
    expect(text).toContain("Beta");
    expect(text).toContain("Beta answer");
    // 1M in * $3 + 1M out * $15 = $18
    expect(text).toContain("≈$18.00");
    expect(text).toContain("1000000 in · 1000000 out tokens");
  });

  it("renders live race lanes with a streaming cursor and error state", async () => {
    await act(async () => {
      root.render(
        <RaceStreamGrid
          streams={[
            { ...stream("s1", "m1", "partial"), status: "error", errorDetail: "boom" },
            stream("s2", "m2", ""),
          ]}
          models={models}
        />,
      );
    });
    const grid = container.querySelector('[data-testid="race-stream"]');
    expect(grid).not.toBeNull();
    const text = grid!.textContent ?? "";
    expect(text).toContain("Alpha");
    expect(text).toContain("partial");
    expect(text).toContain("Beta");
    expect(text).toContain("▍");
    expect(text).toContain("boom");
  });
});
