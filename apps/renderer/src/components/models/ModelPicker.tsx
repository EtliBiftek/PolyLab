import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { Model } from "../../lib/api";
import { useChat } from "../../stores/chat";
import { useModels } from "../../stores/models";
import { useSettings } from "../../stores/settings";
import { CheckIcon, ChevronDownIcon, SearchIcon, SparkIcon } from "../ui/Icons";

/** Effective think state: explicit toggle wins, else the capability flag. */
export function thinkEnabled(model: Model): boolean {
  return model.reasoning_enabled ?? model.supports_reasoning;
}

/**
 * claude.ai-style model picker living inside the composer. The dropdown opens
 * upward from the composer's bottom bar; every model row carries its own think
 * (reasoning) toggle.
 */
export function ModelPicker() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  const models = useModels((state) => state.models);
  const refresh = useModels((state) => state.refresh);
  const setThink = useModels((state) => state.setThink);
  const activeId = useChat((state) => state.activeId);
  const activeModelId = useChat((state) =>
    state.conversations.find((conversation) => conversation.id === state.activeId)?.model_id ?? null,
  );
  const setActiveModel = useChat((state) => state.setActiveModel);
  const lastModelId = useSettings((state) => state.lastModelId);
  const setLastModelId = useSettings((state) => state.setLastModelId);

  const selectedId = activeModelId ?? lastModelId;
  const selected = models.find((model) => model.id === selectedId);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    return () => window.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  const pick = (model: Model) => {
    setLastModelId(model.id);
    if (activeId != null) {
      void setActiveModel(model.id);
    }
    setOpen(false);
  };

  const toggleThink = async (model: Model) => {
    try {
      await setThink(model.id, !thinkEnabled(model));
    } catch {
      // store rolled back; keep the dropdown open
    }
  };

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = models.filter(
      (model) =>
        model.enabled &&
        (needle.length === 0 ||
          model.display_name.toLowerCase().includes(needle) ||
          model.model_id.toLowerCase().includes(needle) ||
          model.provider_name.toLowerCase().includes(needle)),
    );
    const byProvider = new Map<string, Model[]>();
    for (const model of filtered) {
      const list = byProvider.get(model.provider_name) ?? [];
      list.push(model);
      byProvider.set(model.provider_name, list);
    }
    return [...byProvider.entries()];
  }, [models, query]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex h-8 max-w-[220px] items-center gap-1.5 rounded-lg px-2 text-[12.5px] font-medium text-txt-1 transition hover:bg-bg-2 hover:text-txt-0"
      >
        {selected != null && thinkEnabled(selected) && (
          <SparkIcon className="h-3.5 w-3.5 shrink-0 text-accent" />
        )}
        <span className="truncate">
          {selected ? selected.display_name : t("topbar.model.select")}
        </span>
        <ChevronDownIcon className="h-3.5 w-3.5 shrink-0 text-txt-2" />
      </button>

      {open && (
        <div className="absolute bottom-10 left-0 z-50 w-[340px] overflow-hidden rounded-xl border border-border bg-surface shadow-[0_8px_30px_rgba(31,30,29,0.16)]">
          <div className="border-b border-border p-2">
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-txt-2" />
              <input
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("topbar.model.search")}
                className="h-8 w-full rounded-lg border border-border bg-bg-0 pl-8 pr-2 text-[13px] text-txt-0 placeholder:text-txt-2 focus:border-txt-2/40 focus:outline-none"
              />
            </div>
          </div>

          <div className="max-h-[320px] overflow-y-auto p-1.5">
            {groups.length === 0 && (
              <div className="px-3 py-6 text-center text-[13px] leading-relaxed text-txt-2">
                {models.length === 0
                  ? t("topbar.model.noneYet")
                  : t("topbar.model.noMatches")}
              </div>
            )}
            {groups.map(([providerName, groupModels]) => (
              <div key={providerName} className="mb-1">
                <div className="px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-txt-2">
                  {providerName}
                </div>
                {groupModels.map((model) => {
                  const think = thinkEnabled(model);
                  return (
                    <div
                      key={model.id}
                      className={`group/row flex items-center gap-1 rounded-lg pr-1 transition ${
                        model.id === selectedId ? "bg-bg-3" : "hover:bg-bg-2"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => pick(model)}
                        className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left text-[13px] text-txt-1 transition hover:text-txt-0"
                      >
                        <span className="truncate">{model.display_name}</span>
                        {model.id === selectedId && (
                          <CheckIcon className="ml-auto h-3.5 w-3.5 shrink-0 text-accent" />
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => void toggleThink(model)}
                        aria-pressed={think}
                        title={
                          think
                            ? t("chat.think.onHint", { name: model.display_name })
                            : t("chat.think.offHint", { name: model.display_name })
                        }
                        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition ${
                          think
                            ? "text-accent hover:bg-accent/10"
                            : "text-txt-2 hover:bg-bg-3 hover:text-txt-1"
                        }`}
                      >
                        <SparkIcon className="h-4 w-4" />
                      </button>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>

          <button
            type="button"
            onClick={() => {
              setOpen(false);
              useSettings.getState().setSettingsOpen(true);
            }}
            className="w-full border-t border-border px-3 py-2.5 text-left text-[12.5px] text-accent-2 transition hover:bg-bg-2"
          >
            + {t("settings.addProvider")}
          </button>
        </div>
      )}
    </div>
  );
}
