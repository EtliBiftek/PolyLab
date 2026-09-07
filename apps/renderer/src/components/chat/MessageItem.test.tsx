import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import i18n from "../../i18n";
import type { Message, Model } from "../../lib/api";
import { MessageItem } from "./MessageItem";

// The transcript panel is the collapsible replay component; stub it so the
// test only asserts the visibility condition (point 7).
vi.mock("./DebateView", async () => {
  const React = await import("react");
  return {
    DebateTranscript: ({ messageId }: { messageId: string }) =>
      React.createElement("div", {
        "data-testid": "debate-transcript",
        "data-message": messageId,
      }),
  };
});

const model: Model = {
  id: "m1",
  provider_id: "p1",
  model_id: "m1",
  display_name: "Alpha",
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
  price_input: null,
  price_output: null,
  enabled: true,
  provider_kind: "openai_compat",
  provider_name: "Test",
};

const baseMessage: Message = {
  id: "m1",
  conversation_id: "c1",
  role: "assistant",
  content: "cevap",
  reasoning: null,
  model_id: null,
  resolved_model: null,
  has_debate: null,
  tokens_in: null,
  tokens_out: null,
  tokens_estimated: null,
  attachments_json: null,
  feedback: null,
  race_id: null,
  fallback_from_model_id: null,
  created_at: "2026-09-07T00:00:00Z",
};

describe("MessageItem debate transcript visibility (point 7)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = async (message: Message, group: boolean) => {
    await act(async () => {
      root.render(
        <MessageItem message={message} model={undefined} models={[model]} group={group} coding={false} />,
      );
    });
  };

  const transcript = () => container.querySelector('[data-testid="debate-transcript"]');

  it("keeps the transcript after switching to a single model when the message has a debate", async () => {
    await render({ ...baseMessage, has_debate: true }, false);
    expect(transcript()).not.toBeNull();
  });

  it("hides the transcript for plain single-mode messages", async () => {
    await render(baseMessage, false);
    expect(transcript()).toBeNull();
  });

  it("shows the transcript in group mode even before has_debate is known", async () => {
    await render(baseMessage, true);
    expect(transcript()).not.toBeNull();
  });
});
