import { useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * Phase 1 Thinking panel (single model): collapsed bar above the answer, expandable
 * native-reasoning block. Hidden entirely when the model produced no reasoning.
 */
export function ThinkingPanel({
  reasoning,
  streaming,
}: {
  reasoning: string;
  streaming: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  if (reasoning.trim().length === 0) return null;

  const title = streaming
    ? t("thinking.inProgress")
    : t("thinking.title", { chars: reasoning.length });

  return (
    <div className="mb-3">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-2 rounded-lg border border-border bg-bg-1 px-3 py-1.5 text-[12.5px] text-txt-1 transition hover:text-txt-0"
      >
        <span aria-hidden>🧠</span>
        <span>{title}</span>
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
      {open && (
        <div className="mt-2 whitespace-pre-wrap rounded-lg border border-border bg-bg-1/60 px-4 py-3 text-[13px] italic leading-relaxed text-txt-2">
          {reasoning}
          {streaming && <span className="ml-0.5 animate-pulse">▍</span>}
        </div>
      )}
    </div>
  );
}
