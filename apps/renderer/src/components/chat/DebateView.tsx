import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

import { listDebates, type DebateReplay, type Model } from "../../lib/api";
import type { DebateRoundState } from "../../stores/chat";
import type { StreamingMessage } from "../../stores/chat";

function phaseLabel(phase: string, t: TFunction): string {
  if (phase === "initial") return t("debate.phaseInitial");
  if (phase === "critique") return t("debate.phaseCritique");
  return t("debate.phaseSynthesis", "Final answer");
}

function modelName(models: Model[], modelId: string): string | null {
  return models.find((model) => model.id === modelId)?.display_name ?? null;
}

function completedCount(round: DebateRoundState): number {
  return round.turns.filter((turn) => turn.done).length;
}

/** One participant block inside a round. */
function TurnBlock({
  label,
  realName,
  content,
  reasoning,
  tokens,
  done,
  featured = false,
}: {
  label: string;
  realName: string | null;
  content: string;
  reasoning: string;
  tokens: string | null;
  done: boolean;
  featured?: boolean;
}) {
  return (
    <div
      className={
        featured
          ? "rounded-xl border border-accent/35 bg-accent/5 px-4 py-3"
          : "rounded-xl border border-border bg-surface px-3 py-2.5"
      }
    >
      <div className="mb-1.5 flex items-center gap-2">
        {!featured && (
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent/15 text-[10px] font-bold text-accent">
            {label.replace("Model ", "")}
          </span>
        )}
        {featured ? (
          <span className="text-[12px] font-semibold text-accent">Final answer</span>
        ) : (
          <span className="truncate text-[12px] font-semibold text-txt-0">{label}</span>
        )}
        {realName != null && !featured && (
          <span className="truncate text-[11px] text-txt-2">{realName}</span>
        )}
        <span className="flex-1" />
        {done ? (
          <span className="text-[10.5px] text-txt-2">Done</span>
        ) : (
          <span className="inline-flex items-center gap-1 text-[10.5px] text-accent">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
            Thinking
          </span>
        )}
        {tokens != null && (
          <span className="shrink-0 text-[10.5px] tabular-nums text-txt-2">{tokens}</span>
        )}
      </div>
      {reasoning.length > 0 && (
        <p className="mb-1 line-clamp-2 whitespace-pre-wrap text-[11.5px] italic text-txt-2">
          {reasoning.slice(-220)}
        </p>
      )}
      <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-txt-1">
        {content || (!done ? "Working…" : "")}
        {!done && <span className="ml-0.5 inline-block animate-pulse">▍</span>}
      </p>
    </div>
  );
}

function PhaseHeader({
  round,
  modelsDone,
  totalModels,
  phase,
  t,
}: {
  round: number;
  modelsDone: number;
  totalModels: number;
  phase: string;
  t: TFunction;
}) {
  const isSynthesis = phase === "synthesis";
  return (
    <div className="mb-2 flex items-center gap-2">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-txt-2">
        {isSynthesis
          ? t("debate.phaseSynthesis", "Final answer")
          : `${t("debate.round", { n: round })} · ${phaseLabel(phase, t)}`}
      </span>
      {!isSynthesis && totalModels > 0 && (
        <span className="text-[10.5px] text-txt-2">
          {modelsDone}/{totalModels} complete
        </span>
      )}
    </div>
  );
}

function usage(tokensIn: number | null, tokensOut: number | null): string | null {
  if (tokensIn == null && tokensOut == null) return null;
  return `${tokensIn ?? 0}→${tokensOut ?? 0} tok`;
}

/** Live debate view rendered while a group message streams. */
export function DebateStream({
  debate,
  models,
}: {
  debate: DebateRoundState[];
  models: Model[];
}) {
  const { t } = useTranslation();
  const synthesis = debate.find((round) => round.phase === "synthesis");
  const talking = debate.filter((round) => round.phase !== "synthesis");

  return (
    <div className="mb-4 space-y-3">
      {talking.map((round) => (
        <div key={`${round.round}-${round.phase}`} data-testid="debate-round">
          <PhaseHeader
            round={round.round}
            modelsDone={completedCount(round)}
            totalModels={round.turns.length || models.length}
            phase={round.phase}
            t={t}
          />
          <div className="grid gap-2 md:grid-cols-2">
            {round.turns.map((turn) => (
              <TurnBlock
                key={`${round.round}-${turn.modelId}`}
                label={turn.anonLabel}
                realName={modelName(models, turn.modelId)}
                content={turn.content}
                reasoning={turn.reasoning}
                tokens={usage(turn.tokensIn, turn.tokensOut)}
                done={turn.done}
              />
            ))}
          </div>
          {round.consensus != null && (
            <div
              className={`mt-2 rounded-lg px-3 py-2 text-[11px] ${
                round.consensus.reached
                  ? "bg-success/10 text-success"
                  : "bg-warn/10 text-warn"
              }`}
            >
              {round.consensus.reached
                ? t("debate.consensusReached")
                : `${t("debate.consensusNo")}: ${round.consensus.reason}`}
            </div>
          )}
        </div>
      ))}
      {synthesis != null && synthesis.turns.length > 0 && (
        <div className="pt-1">
          <PhaseHeader
            round={synthesis.round}
            modelsDone={completedCount(synthesis)}
            totalModels={synthesis.turns.length}
            phase="synthesis"
            t={t}
          />
          {synthesis.turns.map((turn) => (
            <TurnBlock
              key={`${synthesis.round}-${turn.modelId}`}
              label={turn.anonLabel}
              realName={modelName(models, turn.modelId)}
              content={turn.content}
              reasoning={turn.reasoning}
              tokens={usage(turn.tokensIn, turn.tokensOut)}
              done={turn.done}
              featured
            />
          ))}
        </div>
      )}
      {synthesis == null && debate.length > 0 && (
        <div className="flex items-center gap-2 text-[11px] text-accent">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
          {t("debate.preparingSynthesis", "Comparing the responses and preparing the final answer…")}
        </div>
      )}
    </div>
  );
}

/** Collapsible replay of a finished debate, fetched by message id. */
export function DebateTranscript({ messageId, models }: { messageId: string; models: Model[] }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [replay, setReplay] = useState<DebateReplay[] | null>(null);

  useEffect(() => {
    if (!open || replay != null) return;
    void listDebates({ message_id: messageId })
      .then(setReplay)
      .catch(() => setReplay([]));
  }, [open, messageId, replay]);

  const debate = replay?.[0];
  const rounds = new Map<number, NonNullable<typeof debate>["turns"]>();
  for (const turn of debate?.turns ?? []) {
    rounds.set(turn.round, [...(rounds.get(turn.round) ?? []), turn]);
  }

  return (
    <div className="mb-3">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-1.5 text-[12.5px] text-txt-1 transition hover:text-txt-0"
      >
        <span aria-hidden>⚯</span>
        <span>
          {t("debate.transcript", {
            rounds: debate?.rounds_total ?? "…",
            models: debate?.turns
              ? new Set(debate.turns.filter((x) => x.phase !== "synthesis").map((x) => x.model_id))
                  .size
              : "…",
          })}
        </span>
        {debate?.consensus_reached != null && (
          <span
            className={`rounded-full px-1.5 py-0.5 text-[10px] ${
              debate.consensus_reached ? "bg-success/15 text-success" : "bg-warn/15 text-warn"
            }`}
          >
            {debate.consensus_reached ? t("debate.consensusReached") : t("debate.consensusNo")}
          </span>
        )}
        <svg
          viewBox="0 0 24 24"
          className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-90" : ""}`}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="m9 6 6 6-6 6" />
        </svg>
      </button>
      {open && debate != null && (
        <div className="mt-2 space-y-3">
          {[...rounds.entries()].map(([round, turns]) => {
            const phase = turns[0]?.phase ?? "initial";
            return (
              <div key={round}>
                <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-txt-2">
                  {phaseLabel(phase, t)} {phase !== "synthesis" && `· ${t("debate.round", { n: round })}`}
                </div>
                <div className="grid gap-2 md:grid-cols-2">
                  {turns
                    .filter((turn) => turn.phase !== "synthesis")
                    .map((turn) => (
                      <TurnBlock
                        key={turn.id}
                        label={turn.anon_label}
                        realName={modelName(models, turn.model_id)}
                        content={turn.content}
                        reasoning={turn.reasoning ?? ""}
                        tokens={usage(turn.tokens_in, turn.tokens_out)}
                        done
                      />
                    ))}
                </div>
                {phase === "synthesis" &&
                  turns.map((turn) => (
                    <TurnBlock
                      key={turn.id}
                      label={turn.anon_label}
                      realName={modelName(models, turn.model_id)}
                      content={turn.content}
                      reasoning={turn.reasoning ?? ""}
                      tokens={usage(turn.tokens_in, turn.tokens_out)}
                      done
                      featured
                    />
                  ))}
              </div>
            );
          })}
          <div className="text-[11px] text-txt-2">
            {t("debate.totalTokens", {
              in: debate.total_tokens_in,
              out: debate.total_tokens_out,
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/** Wrapper: shows live debate or replay depending on the streaming state. */
export function DebateArea({
  streaming,
  messageId,
  models,
}: {
  streaming: StreamingMessage | undefined;
  messageId: string;
  models: Model[];
}) {
  if (streaming != null && streaming.debate.length > 0) {
    return <DebateStream debate={streaming.debate} models={models} />;
  }
  return <DebateTranscript messageId={messageId} models={models} />;
}
