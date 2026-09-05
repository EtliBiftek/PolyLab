import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { DebateSettings, Model } from "../../lib/api";
import { useChat } from "../../stores/chat";
import { useModels } from "../../stores/models";
import { useSettings } from "../../stores/settings";
import { CheckIcon, ChevronDownIcon, PlusIcon, SearchIcon, SparkIcon, TrashIcon } from "../ui/Icons";

/** Effective think state: explicit toggle wins, else the capability flag. */
export function thinkEnabled(model: Model): boolean {
  return model.reasoning_enabled ?? model.supports_reasoning;
}

function parseDebateSettings(json: string | null): DebateSettings {
  const fallback: DebateSettings = {
    termination: "fixed",
    max_rounds: 2,
    leader_model_id: null,
    show_names_to_models: false,
  };
  if (json == null) return fallback;
  try {
    return { ...fallback, ...(JSON.parse(json) as Partial<DebateSettings>) };
  } catch {
    return fallback;
  }
}

/**
 * claude.ai-style model picker inside the composer. Two tabs: single models
 * (each with its own think ✦ toggle) and debate groups. Group selection shows
 * inline debate settings (termination, rounds, leader).
 */
export function ModelPicker() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"models" | "groups">("models");
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [newGroupModels, setNewGroupModels] = useState<string[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);

  const models = useModels((state) => state.models);
  const groups = useModels((state) => state.groups);
  const refresh = useModels((state) => state.refresh);
  const setThink = useModels((state) => state.setThink);
  const addGroup = useModels((state) => state.addGroup);
  const removeGroup = useModels((state) => state.removeGroup);
  const activeId = useChat((state) => state.activeId);
  const activeConversation = useChat((state) =>
    state.conversations.find((conversation) => conversation.id === state.activeId),
  );
  const setActiveModel = useChat((state) => state.setActiveModel);
  const setActiveGroup = useChat((state) => state.setActiveGroup);
  const lastModelId = useSettings((state) => state.lastModelId);
  const setLastModelId = useSettings((state) => state.setLastModelId);

  const isGroupMode = activeConversation?.selection_type === "group";
  const selectedGroupId = activeConversation?.group_id ?? null;
  const selectedModelId = activeConversation?.model_id ?? lastModelId;
  const selected = models.find((model) => model.id === selectedModelId);
  const selectedGroup = groups.find((group) => group.id === selectedGroupId);
  const debateSettings = parseDebateSettings(activeConversation?.debate_settings_json ?? null);

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

  const patchDebateSettings = async (patch: Partial<DebateSettings>) => {
    if (activeId == null) return;
    const { updateConversation } = await import("../../lib/api");
    const next = { ...debateSettings, ...patch };
    await updateConversation(activeId, { debate_settings: next });
    void useChat.getState().refresh();
  };

  const pick = (model: Model) => {
    setLastModelId(model.id);
    if (activeId != null) {
      void setActiveModel(model.id);
    }
    setOpen(false);
  };

  const pickGroup = (groupId: string) => {
    if (activeId != null) {
      void setActiveGroup(groupId);
    }
    setOpen(false);
  };

  const toggleThink = async (model: Model) => {
    try {
      await setThink(model.id, !thinkEnabled(model));
    } catch {
      /* rolled back */
    }
  };

  const toggleNewGroupModel = (modelId: string) => {
    setNewGroupModels((current) =>
      current.includes(modelId)
        ? current.filter((id) => id !== modelId)
        : [...current, modelId],
    );
  };

  const createGroup = async () => {
    if (newGroupName.trim().length === 0 || newGroupModels.length < 2) return;
    await addGroup({ name: newGroupName.trim(), model_ids: newGroupModels });
    setNewGroupName("");
    setNewGroupModels([]);
    setCreating(false);
  };

  const groupsByProvider = useMemo(() => {
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

  const triggerLabel = isGroupMode
    ? (selectedGroup?.name ?? t("groups.select"))
    : (selected?.display_name ?? t("topbar.model.select"));

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex h-8 max-w-[240px] items-center gap-1.5 rounded-lg px-2 text-[12.5px] font-medium text-txt-1 transition hover:bg-bg-2 hover:text-txt-0"
      >
        {isGroupMode ? (
          <span className="flex h-4 w-4 shrink-0 items-center justify-center text-[10px] font-bold text-accent">
            ⚯
          </span>
        ) : (
          selected != null &&
          thinkEnabled(selected) && <SparkIcon className="h-3.5 w-3.5 shrink-0 text-accent" />
        )}
        <span className="truncate">{triggerLabel}</span>
        <ChevronDownIcon className="h-3.5 w-3.5 shrink-0 text-txt-2" />
      </button>

      {open && (
        <div className="absolute bottom-10 left-0 z-50 w-[360px] overflow-hidden rounded-xl border border-border bg-surface shadow-[var(--shadow-pop)]">
          {/* Tabs */}
          <div className="flex border-b border-border p-1.5">
            {(["models", "groups"] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setTab(value)}
                aria-pressed={tab === value}
                className={`h-7 flex-1 rounded-lg text-[12.5px] font-medium transition ${
                  tab === value ? "bg-bg-3 text-txt-0" : "text-txt-2 hover:bg-bg-2 hover:text-txt-1"
                }`}
              >
                {t(value === "models" ? "groups.tabModels" : "groups.tabGroups")}
              </button>
            ))}
          </div>

          {tab === "models" && (
            <>
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
              <div className="max-h-[280px] overflow-y-auto p-1.5">
                {groupsByProvider.length === 0 && (
                  <div className="px-3 py-6 text-center text-[13px] leading-relaxed text-txt-2">
                    {models.length === 0
                      ? t("topbar.model.noneYet")
                      : t("topbar.model.noMatches")}
                  </div>
                )}
                {groupsByProvider.map(([providerName, providerModels]) => (
                  <div key={providerName} className="mb-1">
                    <div className="px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-txt-2">
                      {providerName}
                    </div>
                    {providerModels.map((model) => {
                      const think = thinkEnabled(model);
                      return (
                        <div
                          key={model.id}
                          className={`flex items-center gap-1 rounded-lg pr-1 transition ${
                            !isGroupMode && model.id === selectedModelId
                              ? "bg-bg-3"
                              : "hover:bg-bg-2"
                          }`}
                        >
                          <button
                            type="button"
                            onClick={() => pick(model)}
                            className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left text-[13px] text-txt-1 transition hover:text-txt-0"
                          >
                            <span className="truncate">{model.display_name}</span>
                            {!isGroupMode && model.id === selectedModelId && (
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
            </>
          )}

          {tab === "groups" && (
            <div className="max-h-[340px] overflow-y-auto p-1.5">
              {groups.length === 0 && !creating && (
                <div className="px-3 py-5 text-center text-[13px] leading-relaxed text-txt-2">
                  {t("groups.empty")}
                </div>
              )}
              {groups.map((group) => {
                const active = isGroupMode && group.id === selectedGroupId;
                return (
                  <div
                    key={group.id}
                    className={`group/row mb-1 rounded-lg px-2.5 py-2 transition ${
                      active ? "bg-bg-3" : "hover:bg-bg-2"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => pickGroup(group.id)}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left text-[13px] text-txt-1 hover:text-txt-0"
                      >
                        <span className="truncate font-medium">{group.name}</span>
                        <span className="shrink-0 text-[11px] text-txt-2">
                          {group.models.length}
                        </span>
                        {active && <CheckIcon className="ml-auto h-3.5 w-3.5 shrink-0 text-accent" />}
                      </button>
                      <button
                        type="button"
                        title={t("groups.delete")}
                        onClick={() => void removeGroup(group.id)}
                        className="hidden h-6 w-6 shrink-0 items-center justify-center rounded-md text-txt-2 hover:text-danger group-hover/row:flex"
                      >
                        <TrashIcon className="h-3 w-3" />
                      </button>
                    </div>
                    <div className="mt-1 truncate text-[11px] text-txt-2">
                      {group.models.map((model) => model.display_name).join(" · ")}
                    </div>
                    {active && (
                      <div className="mt-2 space-y-2 border-t border-border pt-2">
                        <label className="flex items-center justify-between text-[11.5px] text-txt-1">
                          {t("groups.termination")}
                          <select
                            value={debateSettings.termination}
                            onChange={(event) =>
                              void patchDebateSettings({
                                termination: event.target.value as DebateSettings["termination"],
                              })
                            }
                            className="h-6 rounded-md border border-border bg-bg-0 px-1 text-[11.5px]"
                          >
                            <option value="fixed">{t("groups.terminationFixed")}</option>
                            <option value="consensus">{t("groups.terminationConsensus")}</option>
                          </select>
                        </label>
                        <label className="flex items-center justify-between text-[11.5px] text-txt-1">
                          {t("groups.leader")}
                          <select
                            value={debateSettings.leader_model_id ?? ""}
                            onChange={(event) =>
                              void patchDebateSettings({
                                leader_model_id: event.target.value || null,
                              })
                            }
                            className="h-6 max-w-[150px] rounded-md border border-border bg-bg-0 px-1 text-[11.5px]"
                          >
                            <option value="">{t("groups.leaderAuto")}</option>
                            {group.models.map((model) => (
                              <option key={model.id} value={model.id}>
                                {model.display_name}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="flex items-center justify-between text-[11.5px] text-txt-1">
                          {t("groups.maxRounds")}
                          <input
                            type="number"
                            min={1}
                            max={6}
                            value={debateSettings.max_rounds}
                            onChange={(event) =>
                              void patchDebateSettings({
                                max_rounds: Number(event.target.value),
                              })
                            }
                            className="h-6 w-14 rounded-md border border-border bg-bg-0 px-1 text-[11.5px] tabular-nums"
                          />
                        </label>
                      </div>
                    )}
                  </div>
                );
              })}

              {creating ? (
                <div className="mt-1 rounded-lg border border-border bg-bg-0 p-2">
                  <input
                    autoFocus
                    value={newGroupName}
                    onChange={(event) => setNewGroupName(event.target.value)}
                    placeholder={t("groups.namePlaceholder")}
                    className="mb-2 h-7 w-full rounded-md border border-border bg-surface px-2 text-[12.5px] text-txt-0 placeholder:text-txt-2 focus:outline-none"
                  />
                  <div className="max-h-32 space-y-0.5 overflow-y-auto">
                    {models
                      .filter((model) => model.enabled)
                      .map((model) => (
                        <button
                          key={model.id}
                          type="button"
                          onClick={() => toggleNewGroupModel(model.id)}
                          className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12px] transition ${
                            newGroupModels.includes(model.id)
                              ? "bg-accent/15 text-txt-0"
                              : "text-txt-1 hover:bg-bg-2"
                          }`}
                        >
                          <span
                            className={`flex h-3.5 w-3.5 items-center justify-center rounded border ${
                              newGroupModels.includes(model.id)
                                ? "border-accent bg-accent text-white"
                                : "border-txt-2"
                            }`}
                          >
                            {newGroupModels.includes(model.id) && (
                              <CheckIcon className="h-2.5 w-2.5" />
                            )}
                          </span>
                          <span className="truncate">{model.display_name}</span>
                        </button>
                      ))}
                  </div>
                  <div className="mt-2 flex items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setCreating(false)}
                      className="h-6 rounded-md px-2 text-[11.5px] text-txt-2 hover:text-txt-0"
                    >
                      {t("common.cancel")}
                    </button>
                    <button
                      type="button"
                      onClick={() => void createGroup()}
                      disabled={
                        newGroupName.trim().length === 0 || newGroupModels.length < 2
                      }
                      className="h-6 rounded-md bg-bg-invert px-2.5 text-[11.5px] font-medium text-txt-invert disabled:opacity-40"
                    >
                      {t("groups.create")}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setCreating(true)}
                  className="flex w-full items-center gap-1.5 rounded-lg px-2.5 py-2 text-left text-[12.5px] text-accent-2 hover:bg-bg-2"
                >
                  <PlusIcon className="h-3.5 w-3.5" />
                  {t("groups.new")}
                </button>
              )}
            </div>
          )}

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
