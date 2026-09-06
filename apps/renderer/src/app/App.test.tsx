/**
 * Phase 1 acceptance smoke test: the app mounts with the full Phase 1 surface —
 * backend status, conversation list, model picker, composer — and the TR/EN switch
 * still flips every string.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "./App";
import i18n from "../i18n";
import { useChat } from "../stores/chat";
import type { Message } from "../lib/api";

/* ------------------------------------------------------------------ mocks -- */

class FakeWebSocket {
  static OPEN = 1;
  readyState = 1;
  url: string;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    queueMicrotask(() => {
      this.onopen?.();
      this.onmessage?.({
        data: JSON.stringify({ type: "hello", name: "polylab-core", version: "0.1.0" }),
      });
      this.onmessage?.({ data: JSON.stringify({ type: "pong" }) });
    });
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }
}

const fakeFetch = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  if (url.includes("/health")) {
    return json({ status: "ok", name: "polylab-core", version: "0.1.0", uptime_secs: 1 });
  }
  if (url.includes("/api/providers")) {
    return json([]);
  }
  if (url.includes("/api/models")) {
    return json([]);
  }
  if (url.includes("/api/conversations")) {
    return json([]);
  }
  if (url.includes("/api/settings")) {
    return json({});
  }
  return json({ error: { code: "not_found", detail: url } }, 404);
});

/* ------------------------------------------------------------------- test -- */

describe("App (Phase 1 shell)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    window.localStorage.clear();
    // Module-level zustand stores survive across tests — reset the chat state
    // so a conversation activated in one test does not leak into the next.
    useChat.setState({
      conversations: [],
      activeId: null,
      messages: {},
      streaming: {},
      terminal: {},
      pendingApproval: null,
      sending: false,
    });
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    vi.stubGlobal("fetch", fakeFetch);
    void i18n.changeLanguage("en");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    root.unmount();
    container.remove();
    vi.unstubAllGlobals();
  });

  const flush = () => new Promise((resolve) => setTimeout(resolve, 25));

  const text = () => container.textContent ?? "";
  const findButton = (label: string): HTMLButtonElement | undefined =>
    [...container.querySelectorAll("button")].find(
      (button) => button.textContent === label,
    ) as HTMLButtonElement | undefined;

  it("mounts and shows the backend-connected badge", async () => {
    await act(async () => {
      root.render(<App />);
    });
    await flush();
    await act(async () => {});

    expect(text()).toContain("Backend connected ✓");
    expect(text()).toContain("v0.1.0");
  });

  it("shows the Phase 1 chat surface: composer, empty state, new chat", async () => {
    await act(async () => {
      root.render(<App />);
    });
    await flush();

    expect(findButton("New chat")).toBeDefined();
    // Empty state shows exactly 3 rotating suggestion chips.
    const suggestionButtons = container.querySelectorAll(
      '[data-testid="suggestions"] button',
    );
    expect(suggestionButtons.length).toBe(3);
    for (const button of suggestionButtons) {
      expect(button.textContent?.length ?? 0).toBeGreaterThan(5);
    }
    expect(container.querySelector("textarea")).not.toBeNull();
    expect(text()).toContain("Enter to send");
  });

  it("survives the empty → first-message transition (React #310 regression)", async () => {
    // Regression: App used to call the `streaming` hook conditionally
    // (activeId != null ? useChat(...) : undefined). Mounting with no active
    // conversation and activating one afterwards changed the hook count and
    // crashed the whole tree ("Minified React error #310" / white screen).
    const userMessage: Message = {
      id: "m1",
      conversation_id: "c1",
      role: "user",
      content: "ilk mesaj merhaba",
      reasoning: null,
      model_id: null,
      tokens_in: null,
      tokens_out: null,
      tokens_estimated: null,
      attachments_json: null,
      created_at: "2026-01-01T00:00:00Z",
    };

    await act(async () => {
      root.render(<App />);
    });
    await flush();
    expect(useChat.getState().activeId).toBeNull();

    // First message: a conversation becomes active for the first time.
    await act(async () => {
      useChat.setState({
        activeId: "c1",
        messages: { c1: [userMessage] },
        streaming: { c1: undefined },
      });
    });
    await flush();

    expect(text()).toContain("ilk mesaj merhaba");
  });

  it("switches every UI string between TR and EN", async () => {
    await act(async () => {
      root.render(<App />);
    });
    await flush();
    expect(text()).toContain("New chat");

    await act(async () => {
      findButton("tr")?.click();
    });
    await flush();

    expect(text()).toContain("Yeni sohbet");
    expect(text()).toContain("Backend bağlı ✓");
    expect(i18n.language).toBe("tr");
  });
});
