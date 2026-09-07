import { useState } from "react";
import { useTranslation } from "react-i18next";

import { undoAgentStep } from "../../lib/api";
import type { AgentStepState, PendingApproval } from "../../stores/chat";

/** Tool chip list for a running/finished agent message. */
export function AgentSteps({
  steps,
  onUndone,
}: {
  steps: AgentStepState[];
  /** Called after a successful undo so the parent can reload history. */
  onUndone?: (step: AgentStepState) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<number | null>(null);
  const [undoing, setUndoing] = useState<number | null>(null);

  const undoStep = async (step: AgentStepState) => {
    if (step.conversationId == null || step.messageId == null) return;
    setUndoing(step.step);
    try {
      await undoAgentStep(step.conversationId, step.messageId, step.step);
      onUndone?.(step);
    } finally {
      setUndoing(null);
    }
  };

  if (steps.length === 0) return null;

  return (
    <div className="mb-3 space-y-1" data-testid="agent-steps">
      {steps.map((step) => (
        <div key={step.step} className="rounded-lg border border-border bg-surface">
          <button
            type="button"
            onClick={() => setExpanded(expanded === step.step ? null : step.step)}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px]"
          >
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                step.running ? "animate-pulse bg-accent" : step.ok ? "bg-success" : "bg-danger"
              }`}
            />
            <span className="font-medium text-txt-0">🔧 {step.tool}</span>
            <span className="min-w-0 flex-1 truncate text-[11.5px] text-txt-2">
              {summarizeArgs(step.args)}
            </span>
            {step.running ? (
              <span className="shrink-0 text-[11px] text-accent">{t("agent.running")}</span>
            ) : (
              <span
                className={`shrink-0 text-[11px] ${step.ok ? "text-success" : "text-danger"}`}
              >
                {step.ok ? "✓" : "✕"}
              </span>
            )}
            {!step.running && step.undoable === true && (
              <button
                type="button"
                title={t("agent.undo")}
                aria-label={t("agent.undo")}
                disabled={undoing === step.step}
                onClick={(event) => {
                  event.stopPropagation();
                  void undoStep(step);
                }}
                className="flex h-5 w-6 shrink-0 items-center justify-center rounded text-[11px] text-txt-2 transition hover:bg-bg-2 hover:text-txt-0 disabled:opacity-50"
              >
                {undoing === step.step ? "…" : "↩"}
              </button>
            )}
          </button>
          {expanded === step.step && step.output.length > 0 && (
            <pre className="max-h-48 overflow-auto border-t border-border bg-bg-0 px-3 py-2 text-[11.5px] leading-relaxed text-txt-1">
              {step.output}
            </pre>
          )}
        </div>
      ))}
    </div>
  );
}

function summarizeArgs(argsJson: string): string {
  try {
    const args = JSON.parse(argsJson) as Record<string, unknown>;
    const first = Object.values(args)[0];
    if (typeof first === "string") return first.slice(0, 60);
    return Object.keys(args).join(", ");
  } catch {
    return argsJson.slice(0, 40);
  }
}

/** Floating approval toast for mutating agent tools. */
export function ApprovalToast({
  approval,
  onResolve,
}: {
  approval: PendingApproval;
  onResolve: (approved: boolean) => void;
}) {
  const { t } = useTranslation();
  let detail = approval.argsJson;
  try {
    const args = JSON.parse(approval.argsJson) as Record<string, unknown>;
    const path = args.path ?? args.command ?? args.message;
    if (typeof path === "string") detail = path.slice(0, 80);
  } catch {
    /* keep raw */
  }

  return (
    <div
      className="fixed bottom-24 left-1/2 z-[80] w-[min(480px,92vw)] -translate-x-1/2 rounded-xl border border-border bg-surface p-3 shadow-[var(--shadow-pop)]"
      role="alertdialog"
      data-testid="approval-toast"
    >
      <div className="flex items-center gap-2 text-[13px] font-semibold text-txt-0">
        🔧 {approval.tool}
        <span className="font-normal text-txt-2">{t("agent.needsApproval")}</span>
      </div>
      <p className="mt-1 truncate rounded-md bg-bg-0 px-2 py-1 font-mono text-[11.5px] text-txt-1">
        {detail}
      </p>
      {approval.diff != null && (
        <div className="mt-2">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-txt-2">
            {t("agent.approvalDiff")}
          </div>
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-bg-0 px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-txt-1">
            {approval.diff}
          </pre>
        </div>
      )}
      <div className="mt-2.5 flex justify-end gap-2">
        <button
          type="button"
          onClick={() => onResolve(false)}
          className="h-8 rounded-full border border-border px-3.5 text-[12.5px] font-medium text-txt-1 transition hover:bg-bg-2"
        >
          {t("agent.reject")}
        </button>
        <button
          type="button"
          onClick={() => onResolve(true)}
          className="h-8 rounded-full bg-bg-invert px-3.5 text-[12.5px] font-medium text-txt-invert transition hover:bg-invert-hover"
        >
          {t("agent.approve")}
        </button>
      </div>
    </div>
  );
}
