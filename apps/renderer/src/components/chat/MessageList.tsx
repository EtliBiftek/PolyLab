import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import type { Message, Model } from "../../lib/api";
import type { StreamingMessage } from "../../stores/chat";
import { AgentSteps } from "./AgentView";
import { DebateStream } from "./DebateView";
import { MarkdownBody } from "./MarkdownBody";
import { MessageItem } from "./MessageItem";
import { ThinkingPanel } from "./ThinkingPanel";

function ResponsePlaceholder() {
  const { t } = useTranslation();
  return (
    <div
      className="flex items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3 text-[13px] text-txt-2"
      role="status"
      aria-live="polite"
    >
      <span className="flex gap-1" aria-hidden>
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent [animation-delay:-0.2s]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent [animation-delay:-0.1s]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent" />
      </span>
      <span>{t("chat.preparingResponse", "Preparing a response…")}</span>
    </div>
  );
}

function StreamingAnswer({
  message,
  models,
}: {
  message: StreamingMessage;
  models: Model[];
}) {
  const { t } = useTranslation();
  const isDebate = message.mode === "debate" || message.debate.length > 0;
  return (
    <div className="min-w-0">
      {isDebate && <DebateStream debate={message.debate} models={models} />}
      {!isDebate && message.agentSteps.length > 0 && <AgentSteps steps={message.agentSteps} />}
      {!isDebate && message.reasoning.length > 0 && <ThinkingPanel reasoning={message.reasoning} streaming />}
      {!isDebate && message.content.length > 0 && (
        <>
          <MarkdownBody content={message.content} />
          <span className="ml-0.5 inline-block animate-pulse">▍</span>
        </>
      )}
      {isDebate && message.status === "streaming" && message.debate.length > 0 && (
        <div className="mt-2 text-[11px] text-txt-2">{t("debate.liveProgress", "Models are working through the problem…")}</div>
      )}
      {message.status === "error" && message.errorDetail != null && (
        <div className="mt-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-[12.5px] text-danger">
          {t("chat.providerError")}: {message.errorDetail}
        </div>
      )}
    </div>
  );
}

export function MessageList({
  messages,
  streaming,
  models,
  group,
  coding,
}: {
  messages: Message[];
  streaming: StreamingMessage | undefined;
  models: Model[];
  group: boolean;
  coding: boolean;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const streamedLength = streaming?.content.length ?? 0;
  const streamedReasoningLength = streaming?.reasoning.length ?? 0;
  const streamedTurns = streaming?.debate.reduce(
    (total, round) => total + round.turns.reduce((chars, turn) => chars + turn.content.length, 0),
    0,
  ) ?? 0;
  const waitingForStart = streaming == null && messages.at(-1)?.role === "user";

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, streamedLength, streamedReasoningLength, streamedTurns, waitingForStart]);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6">
      {messages.map((message) => (
        <MessageItem
          key={message.id}
          message={message}
          models={models}
          model={
            message.model_id != null
              ? models.find((model) => model.id === message.model_id)
              : undefined
          }
          group={group}
          coding={coding}
        />
      ))}
      {waitingForStart && <ResponsePlaceholder />}
      {streaming != null && streaming.status === "streaming" && (
        <StreamingAnswer message={streaming} models={models} />
      )}
      <div ref={bottomRef} />
    </div>
  );
}
