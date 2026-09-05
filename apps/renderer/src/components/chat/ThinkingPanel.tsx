import { useState } from "react";
import { useTranslation } from "react-i18next";

import { LogoMark } from "../ui/Icons";

/**
 * Thinking panel — claude.ai style: quiet bordered box, ✻ header, muted gray body.
 * Collapsed by default; streams show "thinking…" state.
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
        className="flex items-center gap-2 rounded-lg px-1.5 py-1 text-[12.5px] text-txt-2 transition hover:text-txt-1"
      >
        <LogoMark className="h-3.5 w-3.5 text-accent" />
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
        <div className="mt-1 whitespace-pre-wrap rounded-xl border border-border bg-white/70 px-4 py-3 text-[13px] leading-relaxed text-txt-2">
          {reasoning}
          {streaming && <span className="ml-0.5 animate-pulse">▍</span>}
        </div>
      )}
    </div>
  );
}
