import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { estimateCostUsd, formatCostUsd, type Message, type Model } from "../../lib/api";
import type { StreamingMessage } from "../../stores/chat";
import { MarkdownBody } from "./MarkdownBody";
import { ThinkingPanel } from "./ThinkingPanel";
import { CheckIcon, CopyIcon } from "../ui/Icons";

function CopyButton({ text }: { text: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      aria-label={t("chat.copy")}
      title={copied ? t("chat.copied") : t("chat.copy")}
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setCopied(true);
      }}
      className={`flex h-6 w-6 items-center justify-center rounded-md transition ${
        copied ? "text-accent" : "text-txt-2 hover:bg-bg-2 hover:text-txt-0"
      }`}
    >
      {copied ? <CheckIcon className="h-3 w-3" /> : <CopyIcon className="h-3 w-3" />}
    </button>
  );
}

/** Live race: one column per in-flight lane (raceStreams entries). */
export function RaceStreamGrid({
  streams,
  models,
}: {
  streams: StreamingMessage[];
  models: Model[];
}) {
  const { t } = useTranslation();
  const labelOf = (stream: StreamingMessage) =>
    stream.resolvedModel ??
    models.find((model) => model.id === stream.modelId)?.display_name ??
    t("chat.race.model");
  return (
    <div className="grid gap-3 sm:grid-cols-2" data-testid="race-stream">
      {streams.map((stream) => (
        <div
          key={stream.id}
          className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-surface"
        >
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" />
            <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-txt-0">
              {labelOf(stream)}
            </span>
          </div>
          <div className="min-h-[80px] flex-1 px-3 py-2.5">
            {stream.reasoning.length > 0 && <ThinkingPanel reasoning={stream.reasoning} streaming />}
            {stream.content.length > 0 ? (
              <>
                <MarkdownBody content={stream.content} />
                <span className="ml-0.5 inline-block animate-pulse">▍</span>
              </>
            ) : (
              <span className="text-[12px] text-txt-2">{t("chat.race.thinking")}</span>
            )}
            {stream.status === "error" && stream.errorDetail != null && (
              <div className="mt-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-[12.5px] text-danger">
                {t("chat.providerError")}: {stream.errorDetail}
              </div>
            )}
            {stream.usage != null && (
              <div className="mt-2 text-[11.5px] tabular-nums text-txt-2">
                {t("chat.usage", {
                  in: `${stream.usage.estimated ? "~" : ""}${stream.usage.tokens_in}`,
                  out: `${stream.usage.estimated ? "~" : ""}${stream.usage.tokens_out}`,
                })}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Persisted race: one column per assistant message of the same race run. */
export function RaceGroup({ messages, models }: { messages: Message[]; models: Model[] }) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-3 sm:grid-cols-2" data-testid="race-group">
      {messages.map((message) => {
        const model = models.find((entry) => entry.id === message.model_id);
        const label = message.resolved_model ?? model?.display_name;
        const cost = estimateCostUsd(
          message.tokens_in,
          message.tokens_out,
          model?.price_input ?? null,
          model?.price_output ?? null,
        );
        return (
          <div
            key={message.id}
            className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-surface"
          >
            <div className="flex items-center gap-2 border-b border-border px-3 py-2">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" />
              <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-txt-0">
                {label ?? t("chat.race.model")}
              </span>
              <CopyButton text={message.content} />
            </div>
            <div className="min-h-[80px] px-3 py-2.5">
              {message.reasoning != null && message.reasoning.length > 0 && (
                <ThinkingPanel reasoning={message.reasoning} streaming={false} />
              )}
              <MarkdownBody content={message.content} />
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-3 py-1.5 text-[11.5px] text-txt-2">
              {message.tokens_in != null || message.tokens_out != null ? (
                <span className="tabular-nums">
                  {t("chat.usage", {
                    in: `${message.tokens_estimated ? "~" : ""}${message.tokens_in ?? 0}`,
                    out: `${message.tokens_estimated ? "~" : ""}${message.tokens_out ?? 0}`,
                  })}
                </span>
              ) : null}
              {cost != null && <span className="tabular-nums">≈{formatCostUsd(cost)}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
