import { memo, useEffect, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";

import type { Message, Model } from "../../lib/api";
import { useChat } from "../../stores/chat";
import { useSettings } from "../../stores/settings";
import { MarkdownBody } from "./MarkdownBody";
import { ThinkingPanel } from "./ThinkingPanel";
import { AgentSteps } from "./AgentView";
import { DebateTranscript } from "./DebateView";
import type { AgentStepState } from "../../stores/chat";
import { CopyIcon, EditIcon, RefreshIcon, ChevronDownIcon, CheckIcon } from "../ui/Icons";

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

/** Small copy button that appears under the bubble on hover (point 4). */
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
  const showTimestamps = useSettings((state) => state.showTimestamps);
  const steps = useAgentSteps(message, coding);
  const editMessage = useChat((state) => state.editMessage);
  const regenerate = useChat((state) => state.regenerate);
  const sending = useChat((state) => state.sending);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const [quoteOld, setQuoteOld] = useState(true);
  const [regenOpen, setRegenOpen] = useState(false);

  const startEdit = () => {
    setDraft(message.content);
    setQuoteOld(true);
    setEditing(true);
  };

  const saveEdit = () => {
    if (draft.trim().length === 0) return;
    setEditing(false);
    void editMessage(message.id, draft, quoteOld);
  };

  const onEditKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      saveEdit();
    }
    if (event.key === "Escape") setEditing(false);
  };

  if (message.role === "user") {
    const attachments = attachmentNames(message);
    return (
      <div className="group/message flex flex-col items-end">
        <div className="max-w-[75%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md border border-border bg-surface px-4 py-2.5 text-[14px] leading-relaxed text-txt-0">
          {editing ? (
            <div className="w-[min(560px,80vw)]">
              <textarea
                autoFocus
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={onEditKeyDown}
                className="max-h-[240px] w-full resize-none bg-transparent text-[14px] leading-relaxed text-txt-0 focus:outline-none"
              />
              <label className="mt-1.5 flex cursor-pointer items-center gap-1.5 text-[11.5px] text-txt-2">
                <input
                  type="checkbox"
                  checked={quoteOld}
                  onChange={(event) => setQuoteOld(event.target.checked)}
                  className="h-3 w-3 accent-[var(--accent)]"
                />
                {t("chat.quoteOld")}
              </label>
              <div className="mt-1.5 flex items-center justify-end gap-1.5">
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  className="rounded-lg px-2.5 py-1 text-[12px] text-txt-2 transition hover:bg-bg-2 hover:text-txt-0"
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  onClick={saveEdit}
                  disabled={draft.trim().length === 0}
                  className="rounded-lg bg-bg-invert px-2.5 py-1 text-[12px] font-medium text-txt-invert transition hover:bg-invert-hover disabled:opacity-50"
                >
                  {t("chat.send")}
                </button>
              </div>
            </div>
          ) : (
            <>
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
            </>
          )}
        </div>
        {/* Hover actions directly below the bubble (point 4). */}
        {!editing && (
          <div className="mt-1 flex items-center gap-0.5 opacity-0 transition group-hover/message:opacity-100">
            <CopyButton text={message.content} />
            {!sending && (
              <button
                type="button"
                aria-label={t("chat.edit")}
                title={t("chat.edit")}
                onClick={startEdit}
                className="flex h-6 w-6 items-center justify-center rounded-md text-txt-2 transition hover:bg-bg-2 hover:text-txt-0"
              >
                <EditIcon className="h-3 w-3" />
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  const usage = usageLabel(message, t);
  // Point 2: show the real served model (alias → resolved name), fallback to
  // the configured display name when the provider did not report it.
  const modelLabel = message.resolved_model ?? model?.display_name;
  return (
    <div className="group/message min-w-0">
      {message.reasoning != null && message.reasoning.length > 0 && (
        <ThinkingPanel reasoning={message.reasoning} streaming={false} />
      )}
      {(group || message.has_debate === true) && (
        <DebateTranscript messageId={message.id} models={models} />
      )}
      {steps.length > 0 && <AgentSteps steps={steps} />}
      <MarkdownBody content={message.content} />
      {(usage != null || modelLabel != null || showTimestamps) && (
        <div className="mt-1.5 flex items-center gap-3 text-[11.5px] text-txt-2">
          {modelLabel != null && <span>{modelLabel}</span>}
          {usage != null && <span className="tabular-nums">{usage}</span>}
          {showTimestamps && (
            <span className="tabular-nums">
              {new Date(message.created_at).toLocaleString()}
            </span>
          )}
        </div>
      )}
      {/* Hover actions below the answer (point 4: copy + regenerate). */}
      <div className="mt-1 flex items-center gap-0.5 opacity-0 transition group-hover/message:opacity-100">
        <CopyButton text={message.content} />
        {!sending && (
          <div className="relative">
            <button
              type="button"
              aria-label={t("chat.regenerate")}
              title={t("chat.regenerate")}
              onClick={() => setRegenOpen((current) => !current)}
              className="flex h-6 items-center gap-0.5 rounded-md px-1 text-txt-2 transition hover:bg-bg-2 hover:text-txt-0"
            >
              <RefreshIcon className="h-3 w-3" />
              <ChevronDownIcon className="h-2.5 w-2.5" />
            </button>
            {regenOpen && (
              <div className="absolute left-0 top-7 z-50 w-52 overflow-hidden rounded-lg border border-border bg-surface py-1 shadow-[var(--shadow-pop)]">
                <button
                  type="button"
                  onClick={() => {
                    setRegenOpen(false);
                    void regenerate(message.id, model?.id ?? null);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-txt-1 transition hover:bg-bg-2 hover:text-txt-0"
                >
                  {t("chat.regenerate")}
                </button>
                {models.length > 0 && (
                  <>
                    <div className="my-1 border-t border-border" />
                    {models
                      .filter((candidate) => candidate.id !== model?.id)
                      .map((candidate) => (
                        <button
                          key={candidate.id}
                          type="button"
                          onClick={() => {
                            setRegenOpen(false);
                            void regenerate(message.id, candidate.id);
                          }}
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-txt-2 transition hover:bg-bg-2 hover:text-txt-0"
                        >
                          <RefreshIcon className="h-3 w-3 shrink-0" />
                          <span className="truncate">{candidate.display_name}</span>
                        </button>
                      ))}
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
});
