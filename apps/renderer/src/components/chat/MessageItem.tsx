import { memo, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { Message, Model } from "../../lib/api";
import { MarkdownBody } from "./MarkdownBody";
import { ThinkingPanel } from "./ThinkingPanel";
import { AgentSteps } from "./AgentView";
import { DebateTranscript } from "./DebateView";
import type { AgentStepState } from "../../stores/chat";

interface AgentStepDto {
  id: string;
  message_id: string;
  seq: number;
  tool: string;
  args_json: string;
  result: string | null;
  ok: boolean;
}

/** Loads persisted agent steps for a finished assistant message (coding mode). */
function useAgentSteps(message: Message, coding: boolean): AgentStepState[] {
  const [steps, setSteps] = useState<AgentStepState[]>([]);
  useEffect(() => {
    if (!coding || message.role !== "assistant" || message.id.startsWith("local-")) {
      setSteps([]);
      return;
    }
    let cancelled = false;
    void import("../../lib/api")
      .then(({ listAgentSteps }) => listAgentSteps(message.id))
      .then((rows: AgentStepDto[]) => {
        if (cancelled) return;
        setSteps(
          rows.map((row) => ({
            step: row.seq,
            tool: row.tool,
            args: row.args_json,
            output: row.result ?? "",
            ok: row.ok,
            running: false,
          })),
        );
      })
      .catch(() => setSteps([]));
    return () => {
      cancelled = true;
    };
  }, [message.id, message.role, coding]);
  return steps;
}

function usageLabel(
  message: { tokens_in: number | null; tokens_out: number | null; tokens_estimated: boolean | null },
  t: (key: string, options?: Record<string, unknown>) => string,
): string | null {
  const { tokens_in, tokens_out } = message;
  if (tokens_in == null && tokens_out == null) return null;
  const estimate = message.tokens_estimated ? "~" : "";
  return t("chat.usage", {
    in: `${estimate}${tokens_in ?? 0}`,
    out: `${estimate}${tokens_out ?? 0}`,
  });
}

function attachmentNames(message: Message): Array<{ name: string; image: boolean }> {
  if (message.attachments_json == null) return [];
  try {
    return (JSON.parse(message.attachments_json) as Array<{
      name: string;
      data_base64?: string;
    }>).map((entry) => ({ name: entry.name, image: entry.data_base64 != null }));
  } catch {
    return [];
  }
}

/** Persisted message (history or finalized). */
export const MessageItem = memo(function MessageItem({
  message,
  model,
  models,
  group,
  coding,
}: {
  message: Message;
  model: Model | undefined;
  models: Model[];
  group: boolean;
  coding: boolean;
}) {
  const { t } = useTranslation();
  const steps = useAgentSteps(message, coding);

  if (message.role === "user") {
    const attachments = attachmentNames(message);
    return (
      <div className="flex justify-end">
        <div className="max-w-[75%] whitespace-pre-wrap rounded-2xl rounded-br-md border border-border bg-surface px-4 py-2.5 text-[14px] leading-relaxed text-txt-0">
          {message.content}
          {attachments.length > 0 && (
            <span className="mt-1.5 flex flex-wrap gap-1.5">
              {attachments.map((attachment) => (
                <span
                  key={attachment.name}
                  className="rounded-full border border-border bg-bg-0 px-2 py-0.5 text-[11px] text-txt-2"
                >
                  {attachment.image ? "🖼" : "📎"} {attachment.name}
                </span>
              ))}
            </span>
          )}
        </div>
      </div>
    );
  }

  const usage = usageLabel(message, t);
  return (
    <div className="min-w-0">
      {message.reasoning != null && message.reasoning.length > 0 && (
        <ThinkingPanel reasoning={message.reasoning} streaming={false} />
      )}
      {group && <DebateTranscript messageId={message.id} models={models} />}
      {steps.length > 0 && <AgentSteps steps={steps} />}
      <MarkdownBody content={message.content} />
      {(usage != null || model != null) && (
        <div className="mt-1.5 flex items-center gap-3 text-[11.5px] text-txt-2">
          {model != null && <span>{model.display_name}</span>}
          {usage != null && <span className="tabular-nums">{usage}</span>}
        </div>
      )}
    </div>
  );
});
