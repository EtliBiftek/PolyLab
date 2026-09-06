import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import type { Message, Model } from "../../lib/api";
import type { StreamingMessage } from "../../stores/chat";
import { AgentSteps } from "./AgentView";
import { DebateStream } from "./DebateView";
import { MarkdownBody } from "./MarkdownBody";
import { MessageItem } from "./MessageItem";
import { ThinkingPanel } from "./ThinkingPanel";

function StreamingAnswer({
  message,
  models,
}: {
  message: StreamingMessage;
  models: Model[];
}) {
  const { t } = useTranslation();
  return (
    <div className="min-w-0">
      {message.debate.length > 0 && <DebateStream debate={message.debate} models={models} />}
      {message.agentSteps.length > 0 && <AgentSteps steps={message.agentSteps} />}
      {message.reasoning.length > 0 && <ThinkingPanel reasoning={message.reasoning} streaming />}
      {/* Debate answers (incl. the live synthesis) are rendered inside DebateStream;
          rendering message.content here too would duplicate the leader's answer. */}
      {message.debate.length === 0 && message.content.length > 0 && (
        <>
          <MarkdownBody content={message.content} />
          <span className="ml-0.5 inline-block animate-pulse">▍</span>
        </>
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

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, streamedLength, streamedReasoningLength, streamedTurns]);

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
      {streaming != null && streaming.status === "streaming" && (
        <StreamingAnswer message={streaming} models={models} />
      )}
      <div ref={bottomRef} />
    </div>
  );
}
