import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MarkdownBody } from "./MarkdownBody";

describe("MarkdownBody", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = async (content: string) => {
    await act(async () => {
      root.render(<MarkdownBody content={content} />);
    });
  };

  it("renders GFM tables and task lists", async () => {
    await render("| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done");
    expect(container.querySelector("table")).not.toBeNull();
    expect(container.querySelector("input[type=checkbox]")).not.toBeNull();
  });

  it("renders inline and block KaTeX math", async () => {
    await render("Euler: $e^{i\\pi} + 1 = 0$\n\n$$\n\\int_0^1 x^2 dx\n$$");
    expect(container.querySelectorAll(".katex").length).toBeGreaterThanOrEqual(2);
  });

  it("renders a mermaid fence as a diagram block", async () => {
    await render("```mermaid\ngraph TD\nA-->B\n```");
    // jsdom has no layout engine — the block shows the fallback with source.
    expect(container.querySelector("button, .rounded-lg")).not.toBeNull();
    expect(container.textContent).toContain("graph TD");
  });

  it("keeps code fences with copy header", async () => {
    await render("```rust\nfn main() {}\n```");
    expect(container.querySelector("pre")).not.toBeNull();
    expect(container.textContent).toContain("rust");
  });
});
