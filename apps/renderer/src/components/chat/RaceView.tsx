import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  estimateCostUsd,
  formatCostUsd,
  saveComparison,
  type Message,
  type Model,
} from "../../lib/api";
import type { StreamingMessage } from "../../stores/chat";
import { MarkdownBody } from "./MarkdownBody";
import { ThinkingPanel } from "./ThinkingPanel";
import { CheckIcon, CopyIcon, TrophyIcon, ChevronDownIcon } from "../ui/Icons";

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

/** Local (session) winner persistence, keyed by race id so it survives reloads. */
function storedWinner(raceId: string): string | null {
  try {
    return localStorage.getItem(`polylab-race-winner:${raceId}`);
  } catch {
    return null;
  }
}
function storeWinner(raceId: string, messageId: string) {
  try {
    localStorage.setItem(`polylab-race-winner:${raceId}`, messageId);
  } catch {
    /* private mode */
  }
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
            {stream.content.length > 0 && <CopyButton text={stream.content} />}
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
export function RaceGroup({
  messages,
  models,
  question,
}: {
  messages: Message[];
  models: Model[];
  /** The user question that started the race (saved with the comparison). */
  question?: string | null;
}) {
  const { t } = useTranslation();
  const raceId = messages[0]?.race_id ?? messages[0]?.id ?? "race";
  const [winnerId, setWinnerId] = useState<string | null>(() => storedWinner(raceId));
  const [collapsed, setCollapsed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);

  const compare = (first: Message, second: Message) => Number(first.id === winnerId) - Number(second.id === winnerId);
  const ordered = useMemo(
    () => (winnerId == null ? messages : [...messages].sort(compare)),
    [messages, winnerId],
  );

  const markWinner = async (message: Message) => {
    setWinnerId(message.id);
    storeWinner(raceId, message.id);
    setSavedNotice(null);
    setSaving(true);
    try {
      await saveComparison({
        conversation_id: message.conversation_id,
        question: question ?? messages[0]?.content.slice(0, 200) ?? null,
        kind: "race",
        winner_entry_id: message.id,
        entries: messages.map((entry) => {
          const model = models.find((candidate) => candidate.id === entry.model_id);
          return {
            model_id: entry.model_id ?? "",
            resolved_model: entry.resolved_model,
            content: entry.content,
            reasoning: entry.reasoning,
            tokens_in: entry.tokens_in,
            tokens_out: entry.tokens_out,
            tokens_estimated: entry.tokens_estimated,
            cost_usd: estimateCostUsd(
              entry.tokens_in,
              entry.tokens_out,
              model?.price_input ?? null,
              model?.price_output ?? null,
            ),
          };
        }),
      });
      setSavedNotice(t("race.saved"));
    } catch (err) {
      setSavedNotice(t("race.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const visible = collapsed && winnerId != null ? ordered.filter((m) => m.id === winnerId) : ordered;
  const losers = messages.length - visible.length;

  return (
    <div data-testid="race-group" className="space-y-2">
      {savedNotice != null && (
        <div className="rounded-lg border border-accent/30 bg-accent/5 px-3 py-1.5 text-[12px] text-txt-1">
          {saving ? t("race.saving") : savedNotice}
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {visible.map((message) => {
          const model = models.find((entry) => entry.id === message.model_id);
          const label = message.resolved_model ?? model?.display_name;
          const isWinner = winnerId === message.id;
          const cost = estimateCostUsd(
            message.tokens_in,
            message.tokens_out,
            model?.price_input ?? null,
            model?.price_output ?? null,
          );
          return (
            <div
              key={message.id}
              className={`flex min-w-0 flex-col overflow-hidden rounded-xl border bg-surface ${
                isWinner ? "border-accent/60 ring-1 ring-accent/40" : "border-border"
              }`}
            >
              <div className="flex items-center gap-2 border-b border-border px-3 py-2">
                {isWinner ? (
                  <TrophyIcon className="h-4 w-4 shrink-0 text-accent" />
                ) : (
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" />
                )}
                <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-txt-0">
                  {label ?? t("chat.race.model")}
                </span>
                {isWinner && (
                  <span className="rounded-full bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent">
                    {t("race.winner")}
                  </span>
                )}
                <button
                  type="button"
                  aria-label={t("race.markWinner")}
                  title={isWinner ? t("race.winnerLabel") : t("race.markWinner")}
                  onClick={() => void markWinner(message)}
                  disabled={saving}
                  className={`flex h-6 w-6 items-center justify-center rounded-md transition disabled:opacity-50 ${
                    isWinner ? "text-accent" : "text-txt-2 hover:bg-bg-2 hover:text-txt-0"
                  }`}
                >
                  <TrophyIcon className="h-3.5 w-3.5" />
                </button>
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
                {winnerId != null && !isWinner && (
                  <span className="text-[10.5px] text-txt-2">{t("race.collapsed")}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {winnerId != null && (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={() => setCollapsed((current) => !current)}
            className="flex items-center gap-1 rounded-full border border-border bg-surface px-2.5 py-1 text-[11.5px] text-txt-2 transition hover:bg-bg-2 hover:text-txt-0"
          >
            <ChevronDownIcon
              className={`h-3 w-3 transition-transform ${collapsed ? "-rotate-90" : ""}`}
            />
            {collapsed
              ? t("race.showLosers", { count: losers })
              : t("race.hideLosers", { count: losers })}
          </button>
        </div>
      )}
    </div>
  );
}
