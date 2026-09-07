import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { Model } from "../../lib/api";
import { useModels } from "../../stores/models";
import { ChevronDownIcon } from "../ui/Icons";

/** Named think levels a model exposes; a single level needs no selector. */
export function thinkLevels(model: Model): string[] {
  const options = model.reasoning_options ?? [];
  return options.length > 1 ? options : [];
}

export function ThinkEffortMenu({
  model,
  align = "left",
}: {
  model: Model;
  align?: "left" | "right";
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const setReasoningEffort = useModels((state) => state.setReasoningEffort);
  const levels = thinkLevels(model);

  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open]);

  if (levels.length === 0) return null;

  const label = model.reasoning_effort != null ? t(`chat.think.${model.reasoning_effort}`) : t("chat.think.auto");

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        title={t("chat.think.levelHint", { name: model.display_name })}
        className={`flex h-7 max-w-[120px] shrink-0 items-center gap-0.5 rounded-lg px-1.5 text-[11px] transition ${
          open ? "bg-bg-3 text-txt-0" : "text-txt-2 hover:bg-bg-2 hover:text-txt-1"
        }`}
      >
        <span className="truncate">{label}</span>
        <ChevronDownIcon className="h-3 w-3 shrink-0" />
      </button>
      {open && (
        <div
          className={`absolute bottom-8 z-50 w-32 overflow-hidden rounded-lg border border-border bg-surface py-1 shadow-[var(--shadow-pop)] ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              void setReasoningEffort(model.id, null);
            }}
            className={`flex w-full items-center px-3 py-1.5 text-left text-[12.5px] transition hover:bg-bg-2 ${
              model.reasoning_effort == null ? "text-accent" : "text-txt-1"
            }`}
          >
            {t("chat.think.auto")}
          </button>
          {levels.map((level) => (
            <button
              key={level}
              type="button"
              onClick={() => {
                setOpen(false);
                void setReasoningEffort(model.id, level);
              }}
              className={`flex w-full items-center px-3 py-1.5 text-left text-[12.5px] transition hover:bg-bg-2 ${
                model.reasoning_effort === level ? "text-accent" : "text-txt-1"
              }`}
            >
              {t(`chat.think.${level}`)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
