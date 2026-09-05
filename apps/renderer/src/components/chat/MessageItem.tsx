import { memo } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import type { Message, Model } from "../../lib/api";
import { ThinkingPanel } from "./ThinkingPanel";

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

/** Persisted message (history or finalized). */
export const MessageItem = memo(function MessageItem({
  message,
  model,
}: {
  message: Message;
  model: Model | undefined;
}) {
  const { t } = useTranslation();

  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[75%] whitespace-pre-wrap rounded-2xl rounded-br-md border border-border bg-bg-2 px-4 py-2.5 text-[14px] leading-relaxed text-txt-0">
          {message.content}
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
      <div className="prose-invert max-w-none text-[14.5px] leading-relaxed text-txt-0 [&_a]:text-accent-2 [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-txt-1 [&_code]:rounded [&_code]:bg-bg-2 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[13px] [&_code]:text-[#eabac2] [&_h1]:mb-2 [&_h1]:mt-4 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:mb-2 [&_h2]:mt-4 [&_h2]:font-semibold [&_h3]:mb-1 [&_h3]:mt-3 [&_h3]:font-semibold [&_li]:my-0.5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-border [&_pre]:bg-bg-1 [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:text-[12.5px] [&_strong]:font-semibold [&_table]:my-2 [&_table]:w-full [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
      </div>
      {(usage != null || model != null) && (
        <div className="mt-1.5 flex items-center gap-3 text-[11.5px] text-txt-2">
          {model != null && <span>{model.display_name}</span>}
          {usage != null && <span className="tabular-nums">{usage}</span>}
        </div>
      )}
    </div>
  );
});
