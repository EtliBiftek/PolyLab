import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { Message, Model } from "../../lib/api";
import type { StreamingMessage } from "../../stores/chat";
import { AgentSteps } from "./AgentView";
import { DebateStream } from "./DebateView";
import { MarkdownBody } from "./MarkdownBody";
import { MessageItem } from "./MessageItem";
import { RaceGroup, RaceStreamGrid } from "./RaceView";
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
      {(message.resolvedModel != null || message.usage != null) && (
        <div className="mt-1.5 flex items-center gap-3 text-[11.5px] text-txt-2">
          {message.resolvedModel != null && <span>{message.resolvedModel}</span>}
          {message.usage != null && (
            <span className="tabular-nums">
              {t("chat.usage", {
                in: `${message.usage.estimated ? "~" : ""}${message.usage.tokens_in}`,
                out: `${message.usage.estimated ? "~" : ""}${message.usage.tokens_out}`,
              })}
            </span>
          )}
        </div>
      )}
      {message.status === "error" && message.errorDetail != null && (
        <div className="mt-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-[12.5px] text-danger">
          {t("chat.providerError")}: {message.errorDetail}
        </div>
      )}
    </div>
  );
}

/** Groups consecutive assistant messages that share a race_id. */
function groupRaces(messages: Message[], models: Model[]): ReactNode[] {
  const nodes: ReactNode[] = [];
  let index = 0;
  while (index < messages.length) {
    const message = messages[index];
    if (message.race_id != null) {
      const raceId = message.race_id;
      const group: Message[] = [];
      while (index < messages.length && messages[index].race_id === raceId) {
        group.push(messages[index]);
        index++;
      }
      nodes.push(<RaceGroup key={`race-${raceId}`} messages={group} models={models} />);
    } else {
      index++;
    }
  }
  return nodes;
}

export function MessageList({
  messages,
  streaming,
  raceStreams,
  models,
  group,
  coding,
  searchQuery,
  clearSearch,
}: {
  messages: Message[];
  streaming: StreamingMessage | undefined;
  /** In-flight model-race lanes (one per model, keyed by message id). */
  raceStreams: StreamingMessage[];
  models: Model[];
  group: boolean;
  coding: boolean;
  /** In-conversation text filter ('' = off). */
  searchQuery: string;
  clearSearch: () => void;
}) {
  const { t } = useTranslation();
  const bottomRef = useRef<HTMLDivElement>(null);
  const streamedLength = streaming?.content.length ?? 0;
  const streamedReasoningLength = streaming?.reasoning.length ?? 0;
  const streamedRaceLength = raceStreams.reduce(
    (total, stream) => total + stream.content.length + stream.reasoning.length,
    0,
  );
  const streamedTurns = streaming?.debate.reduce(
    (total, round) => total + round.turns.reduce((chars, turn) => chars + turn.content.length, 0),
    0,
  ) ?? 0;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, streamedLength, streamedReasoningLength, streamedRaceLength, streamedTurns]);

  const needle = searchQuery.trim().toLowerCase();
  const visible =
    needle.length === 0
      ? messages
      : messages.filter((message) => message.content.toLowerCase().includes(needle));

  const raceGroups = useMemo(() => groupRaces(visible, models), [visible, models]);
  const raceStreamGroups = useMemo(() => {
    const byRace = new Map<string, StreamingMessage[]>();
    for (const stream of raceStreams) {
      if (stream.raceId == null) continue;
      const list = byRace.get(stream.raceId) ?? [];
      list.push(stream);
      byRace.set(stream.raceId, list);
    }
    return [...byRace.values()];
  }, [raceStreams]);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-6">
      {needle.length > 0 && (
        <div className="flex items-center justify-between rounded-lg border border-accent/30 bg-accent/5 px-3 py-2 text-[12px] text-txt-1">
          <span>{t("chat.searchMatches", { count: visible.length, total: messages.length })}</span>
          <button type="button" onClick={clearSearch} className="rounded px-2 py-0.5 text-txt-2 transition hover:bg-bg-2 hover:text-txt-0">
            {t("common.clear")}
          </button>
        </div>
      )}
      {visible.map((message) => {
        if (message.race_id != null) return null; // rendered by raceGroups
        return (
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
        );
      })}
      {raceGroups}
      {raceStreamGroups.map((streams) => (
        <RaceStreamGrid key={`race-stream-${streams[0]?.raceId ?? "live"}`} streams={streams} models={models} />
      ))}
      {streaming != null && streaming.status === "streaming" && (
        <StreamingAnswer message={streaming} models={models} />
      )}
      <div ref={bottomRef} />
    </div>
  );
}
