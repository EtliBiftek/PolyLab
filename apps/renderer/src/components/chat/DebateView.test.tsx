import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import i18n from "../../i18n";
import type { Model } from "../../lib/api";
import type { DebateRoundState } from "../../stores/chat";
import { DebateStream } from "./DebateView";

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
  enabled: true,
  provider_kind: "openai_compat",
  provider_name: "Test",
});

const models = [model("m1", "Alpha"), model("m2", "Beta")];

const debate: DebateRoundState[] = [
  {
    round: 1,
    phase: "initial",
    turns: [
      {
        modelId: "m1",
        anonLabel: "Model A",
        content: "Alpha's opening answer",
        reasoning: "Alpha reasoning",
        tokensIn: 10,
        tokensOut: 20,
        done: true,
      },
      {
        modelId: "m2",
        anonLabel: "Model B",
        content: "Beta's opening answer",
        reasoning: "",
        tokensIn: 11,
        tokensOut: 21,
        done: true,
      },
    ],
    consensus: null,
  },
  {
    round: 2,
    phase: "synthesis",
    turns: [
      {
        modelId: "m1",
        anonLabel: "Model A",
        content: "The final synthesis answer.",
        reasoning: "Leader thinking",
        tokensIn: 30,
        tokensOut: 40,
        done: true,
      },
    ],
    consensus: { reached: false, reason: "max rounds reached" },
  },
];

/* ------------------------------------------------------------- harness -- */

describe("DebateStream", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    void i18n.changeLanguage("en");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  const render = async () => {
    await act(async () => {
      root.render(<DebateStream debate={debate} models={models} />);
    });
  };

  const text = () => container.textContent ?? "";
  const hiddenContainers = () =>
    [...container.querySelectorAll("div.hidden")].map((el) => (el.textContent ?? "").trim());

  it("renders every round, including the live synthesis round", async () => {
    await render();
    expect(text()).toContain("Round 1");
    expect(text()).toContain("Leader synthesis");
    expect(text()).toContain("The final synthesis answer.");
  });

  it("keeps participant answers collapsed by default and shows a preview", async () => {
    await render();
    // Full answers stay in the hidden content container.
    const hidden = hiddenContainers();
    expect(hidden.some((value) => value.includes("Alpha's opening answer"))).toBe(true);
    expect(hidden.some((value) => value.includes("Beta's opening answer"))).toBe(true);
    // Collapsed previews are visible.
    expect(text()).toContain("Alpha's opening answer");
    // The synthesis block is expanded (it is the main answer).
    expect(hidden.some((value) => value.includes("The final synthesis answer."))).toBe(false);
  });

  it("toggles a participant answer open and closed", async () => {
    await render();
    const toggle = [...container.querySelectorAll("button")].find(
      (button) => button.getAttribute("aria-label") === "Expand answer",
    );
    expect(toggle).toBeDefined();

    await act(async () => {
      toggle?.click();
    });
    expect(hiddenContainers().some((value) => value.includes("Alpha's opening answer"))).toBe(false);
    expect(text()).toContain("Alpha reasoning");

    await act(async () => {
      toggle?.click();
    });
    expect(hiddenContainers().some((value) => value.includes("Alpha's opening answer"))).toBe(true);
  });

  it("shows the reasoning section inside an expanded turn", async () => {
    await render();
    await act(async () => {
      const toggle = [...container.querySelectorAll("button")].find(
        (button) => button.getAttribute("aria-label") === "Expand answer",
      );
      toggle?.click();
    });
    expect(text()).toContain("Thinking process");
    expect(hiddenContainers().some((value) => value.includes("Alpha reasoning"))).toBe(false);
  });
});
