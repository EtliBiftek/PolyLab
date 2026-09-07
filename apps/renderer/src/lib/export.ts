import type { Conversation, Message } from "./api";

/** Renders a conversation as human-readable Markdown for backup/sharing. */
export function conversationToMarkdown(conversation: Conversation, messages: Message[]): string {
  const title = conversation.title ?? "Untitled chat";
  const lines: string[] = [`# ${title}`, ""];
  lines.push(`> Model: ${conversation.model_id ?? "—"} · Mode: ${conversation.mode} · Exported: ${new Date().toISOString()}`);
  lines.push("");
  for (const message of messages) {
    const model = message.resolved_model ?? message.model_id ?? "";
    lines.push(`## ${message.role === "user" ? "User" : "Assistant"}${model ? ` · ${model}` : ""}`);
    lines.push("");
    if (message.reasoning != null && message.reasoning.length > 0) {
      lines.push(`<details><summary>Reasoning</summary>`);
      lines.push("");
      lines.push("```");
      lines.push(message.reasoning);
      lines.push("```");
      lines.push("");
      lines.push("</details>");
      lines.push("");
    }
    lines.push(message.content);
    lines.push("");
  }
  return lines.join("\n");
}

export function downloadText(filename: string, content: string, mime = "text/plain"): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function safeFilename(title: string | null): string {
  const base = (title ?? "conversation")
    .toLowerCase()
    .replace(/[^a-z0-9çğıöşü]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return base.length > 0 ? base : "conversation";
}

/** Parses a JSON export (or plain Markdown with "# title / ## role / body
 *  sections") into an import payload. Plain Markdown import keeps the
 *  conversation untitled unless a `#` heading is present. */
export function parseConversationImport(text: string): {
  title: string | null;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  json?: boolean;
} {
  try {
    const parsed = JSON.parse(text) as {
      conversation?: { title?: string | null; mode?: string };
      title?: string | null;
      messages?: Array<{ role?: string; content?: string }>;
    };
    if (Array.isArray(parsed.messages)) {
      const messages = parsed.messages
        .filter((message) => (message.role === "user" || message.role === "assistant") && typeof message.content === "string")
        .map((message) => ({ role: message.role as "user" | "assistant", content: message.content as string }));
      if (messages.length > 0) {
        return {
          title: parsed.conversation?.title ?? parsed.title ?? null,
          messages,
          json: true,
        };
      }
    }
  } catch {
    /* not JSON — fall through to Markdown */
  }
  const lines = text.split(/\r?\n/);
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  let title: string | null = null;
  let current: { role: "user" | "assistant"; content: string } | null = null;
  for (const line of lines) {
    const heading = /^##\s+(User|Assistant)(?:\s*·\s*(.*))?$/i.exec(line);
    if (heading != null) {
      if (current != null) messages.push(current);
      current = { role: heading[1].toLowerCase() as "user" | "assistant", content: "" };
      continue;
    }
    const titleMatch = /^#\s+(.+)$/.exec(line);
    if (titleMatch != null && title == null) {
      title = titleMatch[1].trim();
      continue;
    }
    if (current != null) current.content += `${line}\n`;
  }
  if (current != null) messages.push(current);
  return { title, messages: messages.map((message) => ({ ...message, content: message.content.trim() })) };
}
