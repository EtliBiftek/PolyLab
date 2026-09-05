import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import type { Message, Model } from "../../lib/api";
import type { StreamingMessage } from "../../stores/chat";
import { MessageItem } from "./MessageItem";
import { ThinkingPanel } from "./ThinkingPanel";

function StreamingAnswer({ message }: { message: StreamingMessage }) {
  const { t } = useTranslation();
  return (
    <div className="min-w-0">
      <ThinkingPanel reasoning={message.reasoning} streaming />
      <div className="prose-invert max-w-none text-[14.5px] leading-relaxed text-txt-0 [&_a]:text-accent-2 [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-txt-1 [&_code]:rounded [&_code]:bg-bg-2 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[13px] [&_p]:my-2 [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-border [&_pre]:bg-bg-1 [&_pre]:p-3 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_h1]:mb-2 [&_h1]:mt-4 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:mb-2 [&_h2]:mt-4 [&_h2]:font-semibold [&_strong]:font-semibold [&_table]:my-2 [&_table]:w-full [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
        <span className="ml-0.5 inline-block animate-pulse">▍</span>
      </div>
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
}: {
  messages: Message[];
  streaming: StreamingMessage | undefined;
  models: Model[];
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const streamedLength = streaming?.content.length ?? 0;
  const streamedReasoningLength = streaming?.reasoning.length ?? 0;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, streamedLength, streamedReasoningLength]);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6">
      {messages.map((message) => (
        <MessageItem
          key={message.id}
          message={message}
          model={
            message.model_id != null
              ? models.find((model) => model.id === message.model_id)
              : undefined
          }
        />
      ))}
      {streaming != null && streaming.status === "streaming" && (
        <StreamingAnswer message={streaming} />
      )}
      <div ref={bottomRef} />
    </div>
  );
}
