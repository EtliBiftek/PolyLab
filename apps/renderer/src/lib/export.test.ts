import { describe, expect, it } from "vitest";

import { conversationToMarkdown, parseConversationImport, safeFilename } from "./export";

const messages = [
  {
    id: "m1",
    conversation_id: "c1",
    role: "user" as const,
    content: "Merhaba",
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
  },
  {
    id: "m2",
    conversation_id: "c1",
    role: "assistant" as const,
    content: "Selam!",
    reasoning: "düşünme",
    model_id: "m1",
    resolved_model: "alpha-1",
    has_debate: null,
    tokens_in: 10,
    tokens_out: 5,
    tokens_estimated: false,
    attachments_json: null,
    feedback: null,
    race_id: null,
    fallback_from_model_id: null,
    created_at: "2026-09-07T00:00:01Z",
  },
];

describe("conversation markdown export", () => {
  it("renders headings and reasoning details", () => {
    const md = conversationToMarkdown(
      { title: "Test Sohbet" } as never,
      messages,
    );
    expect(md).toContain("# Test Sohbet");
    expect(md).toContain("## User");
    expect(md).toContain("## Assistant · alpha-1");
    expect(md).toContain("<details><summary>Reasoning</summary>");
    expect(md).toContain("Selam!");
  });
});

describe("import parsing", () => {
  it("parses JSON exports", () => {
    const parsed = parseConversationImport(
      JSON.stringify({ conversation: { title: "Geri" }, messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }] }),
       );
    expect(parsed.json).toBe(true);
    expect(parsed.title).toBe("Geri");
    expect(parsed.messages).toHaveLength(2);
  });

  it("parses plain Markdown", () => {
    const parsed = parseConversationImport(
      "# Başlık\n\n## User\nMerhaba\n\n## Assistant\nSelam",
    );
    expect(parsed.json).toBeUndefined();
    expect(parsed.title).toBe("Başlık");
    expect(parsed.messages).toEqual([
      { role: "user", content: "Merhaba" },
      { role: "assistant", content: "Selam" },
    ]);
  });

  it("rejects empty / invalid input gracefully", () => {
    const parsed = parseConversationImport("```bu bir kod değil```");
    expect(parsed.messages).toHaveLength(0);
  });

  it("sanitizes filenames", () => {
    expect(safeFilename("Köprü & Sohbet: 1")).toMatch(/^[a-z0-9çğıöşü-]+$/i);
    expect(safeFilename(null)).toBe("conversation");
  });
});
