import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { listDebates, type DebateReplay, type Model } from "../../lib/api";
import type { DebateRoundState } from "../../stores/chat";
import type { StreamingMessage } from "../../stores/chat";

function phaseLabel(phase: string, t: (key: string) => string): string {
  if (phase === "initial") return t("debate.phaseInitial");
  if (phase === "critique") return t("debate.phaseCritique");
  return t("debate.phaseSynthesis");
}

function modelName(models: Model[], modelId: string): string | null {
  return models.find((model) => model.id === modelId)?.display_name ?? null;
}

/**
 * Soft typewriter reveal. While streaming, the visible text chases the latest
 * content with a decaying step (fast at first, gentle at the end) driven by
 * requestAnimationFrame, so deltas appear as a smooth writing animation instead
 * of hard jumps. When the turn is done the whole text is shown immediately.
 *
 * The content stays mounted (CSS hides it) so collapsing/expanding a turn never
 * replays the animation.
 */
function useSoftReveal(text: string, streaming: boolean): string {
  const [shown, setShown] = useState(0);
  const shownRef = useRef(0);

  useEffect(() => {
    if (!streaming || typeof requestAnimationFrame === "undefined") {
      shownRef.current = text.length;
      setShown(text.length);
      return;
    }
    let raf = 0;
    const tick = () => {
      const target = text.length;
      const current = shownRef.current;
      if (current >= target) return;
      const step = Math.max(1, Math.ceil((target - current) / 14));
      const next = Math.min(target, current + step);
      shownRef.current = next;
      setShown(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [text, streaming]);

  return text.slice(0, shown);
}

/** Soft pulse caret used while a turn is still writing. */
function SoftCaret() {
  return (
    <span
      aria-hidden
      className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[0.16em] animate-pulse rounded-full bg-accent/70"
    />
  );
}

/** One participant block inside a round — collapsible, collapsed by default. */
function TurnBlock({
  label,
  realName,
  content,
  reasoning,
  tokens,
  done,
  accent = false,
  defaultCollapsed = true,
}: {
  label: string;
  realName: string | null;
  content: string;
  reasoning: string;
  tokens: string | null;
  done: boolean;
  accent?: boolean;
  defaultCollapsed?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(!defaultCollapsed);
  const visibleContent = useSoftReveal(content, !done);
  const visibleReasoning = useSoftReveal(reasoning, !done);
  const preview = content.trim().replace(/\s+/g, " ").slice(0, 160);

  return (
    <div
      className={`rounded-xl border bg-surface px-3 py-2.5 transition-colors ${
        accent ? "border-accent/25" : "border-border"
      }`}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-label={open ? t("debate.collapseAnswer") : t("debate.expandAnswer")}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <span
            className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
              accent ? "bg-accent/20 text-accent" : "bg-accent/15 text-accent"
            }`}
          >
            {label.replace("Model ", "")}
          </span>
          <span className="truncate text-[12px] font-semibold text-txt-0">{label}</span>
          {realName != null && <span className="truncate text-[11px] text-txt-2">{realName}</span>}
        </button>
        {tokens != null && (
          <span className="shrink-0 text-[10.5px] tabular-nums text-txt-2">{tokens}</span>
        )}
        {!done && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" />}
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-hidden
          tabIndex={-1}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-txt-2 transition hover:bg-bg-1 hover:text-txt-0"
        >
          <svg
            viewBox="0 0 24 24"
            className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-90" : ""}`}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m9 6 6 6-6 6" />
          </svg>
        </button>
      </div>

      {/* Content stays mounted so the reveal never replays on expand/collapse. */}
      <div className={open ? "" : "hidden"}>
        {reasoning.length > 0 && (
          <div className="mt-2 rounded-lg border border-border/70 bg-bg-1/60 px-3 py-2">
            <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-txt-2">
              <span aria-hidden>✻</span>
              <span>{t("debate.thinking")}</span>
            </div>
            <div className="whitespace-pre-wrap text-[12px] leading-relaxed text-txt-2">
              {visibleReasoning}
              {!done && <SoftCaret />}
            </div>
          </div>
        )}
        <p className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-txt-1">
          {visibleContent}
          {!done && <SoftCaret />}
        </p>
      </div>
      {!open && preview.length > 0 && (
        <p data-testid="turn-preview" className="mt-1 truncate text-[11.5px] text-txt-2/80" title={preview}>
          {preview}
        </p>
      )}
    </div>
  );
}

function usage(tokensIn: number | null, tokensOut: number | null): string | null {
  if (tokensIn == null && tokensOut == null) return null;
  return `${tokensIn ?? 0}→${tokensOut ?? 0} tok`;
}

function RoundBadge({ text, tone }: { text: string; tone: "ok" | "warn" }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10.5px] font-medium ${
        tone === "ok" ? "bg-success/15 text-success" : "bg-warn/15 text-warn"
      }`}
    >
      {text}
    </span>
  );
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
  const talking = debate.slice(0, synthesis ? -1 : undefined);

  return (
    <div className="mb-4 space-y-3">
      {talking.map((round) => (
        <div key={round.round} data-testid="debate-round">
          <div className="mb-1.5 flex items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-txt-2">
              {t("debate.round", { n: round.round })} · {phaseLabel(round.phase, t)}
            </span>
            {round.consensus != null && (
              <RoundBadge
                text={round.consensus.reached ? t("debate.consensusReached") : t("debate.consensusNo")}
                tone={round.consensus.reached ? "ok" : "warn"}
              />
            )}
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            {round.turns.map((turn) => (
              <TurnBlock
                key={turn.modelId}
                label={turn.anonLabel}
                realName={modelName(models, turn.modelId)}
                content={turn.content}
                reasoning={turn.reasoning}
                tokens={usage(turn.tokensIn, turn.tokensOut)}
                done={turn.done}
              />
            ))}
          </div>
        </div>
      ))}

      {synthesis != null && (
        <div data-testid="debate-synthesis">
          <div className="mb-1.5 flex items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-accent">
              ✻ {t("debate.phaseSynthesis")}
            </span>
            {synthesis.consensus != null && (
              <RoundBadge
                text={synthesis.consensus.reached ? t("debate.consensusReached") : t("debate.consensusNo")}
                tone={synthesis.consensus.reached ? "ok" : "warn"}
              />
            )}
          </div>
          {synthesis.turns.length === 0 ? (
            <div className="rounded-xl border border-accent/20 bg-surface px-3 py-2.5">
              <div className="flex items-center gap-2 text-[12.5px] text-txt-2">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
                {t("thinking.inProgress")}
              </div>
            </div>
          ) : (
            <div className="grid gap-2">
              {synthesis.turns.map((turn) => (
                <TurnBlock
                  key={turn.modelId}
                  label={turn.anonLabel}
                  realName={modelName(models, turn.modelId)}
                  content={turn.content}
                  reasoning={turn.reasoning}
                  tokens={usage(turn.tokensIn, turn.tokensOut)}
                  done={turn.done}
                  accent
                  defaultCollapsed={false}
                />
              ))}
            </div>
          )}
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
          <RoundBadge
            text={debate.consensus_reached ? t("debate.consensusReached") : t("debate.consensusNo")}
            tone={debate.consensus_reached ? "ok" : "warn"}
          />
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
          {[...rounds.entries()].map(([round, turns]) => (
            <div key={round}>
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-txt-2">
                {t("debate.round", { n: round })} · {phaseLabel(turns[0]?.phase ?? "initial", t)}
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
            </div>
          ))}
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
