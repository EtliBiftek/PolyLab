import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import i18n from "../../i18n";
import { ApprovalToast } from "./AgentView";

describe("ApprovalToast", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onResolve = vi.fn();

  beforeEach(async () => {
    await i18n.init();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    onResolve.mockClear();
  });

  it("shows the unified diff for file writes before approval", async () => {
    await act(async () => {
      root.render(
        <ApprovalToast
          approval={{
            approvalId: "a1",
            tool: "fs_write",
            argsJson: '{"path":"a.txt","content":"new"}',
            diff: "--- a.txt\n+++ a.txt\n@@ -1,1 +1,1 @@\n-old\n+new",
          }}
          onResolve={onResolve}
        />,
      );
    });
    const toast = container.querySelector('[data-testid="approval-toast"]');
    expect(toast).not.toBeNull();
    const text = toast!.textContent ?? "";
    expect(text).toContain("fs_write");
    expect(text).toContain("Change diff");
    expect(text).toContain("-old");
    expect(text).toContain("+new");
  });

  it("resolves approved from the button", async () => {
    await act(async () => {
      root.render(
        <ApprovalToast
          approval={{
            approvalId: "a1",
            tool: "exec",
            argsJson: '{"command":"ls"}',
            diff: null,
          }}
          onResolve={onResolve}
        />,
      );
    });
    const buttons = [...container.querySelectorAll("button")];
    const approve = buttons.find((button) => button.textContent?.includes("Approve"));
    expect(approve).toBeDefined();
    await act(async () => approve!.click());
    expect(onResolve).toHaveBeenCalledWith(true);
  });
});
