import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { updateConversation } from "../../lib/api";
import { bridge } from "../../lib/backend";
import { useChat } from "../../stores/chat";
import { useCost, currentMonthUsd } from "../../stores/cost";
import { useSettings } from "../../stores/settings";
import { formatCostUsd } from "../../lib/api";
import {
  ChatIcon,
  ChevronDownIcon,
  CodeIcon,
  FolderIcon,
  LogoMark,
  PanelRightIcon,
  SearchIcon,
} from "../ui/Icons";

export function TopBar() {
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [agentMenuOpen, setAgentMenuOpen] = useState(false);
  const { t } = useTranslation();
  const mode = useSettings((state) => state.mode);
  const setMode = useSettings((state) => state.setMode);
  const updateConversationMode = useChat((state) => state.updateMode);
  const setAutoApprove = useChat((state) => state.setAutoApprove);
  const setPlanMode = useChat((state) => state.setPlanMode);
  const setApprovalProfile = useChat((state) => state.setApprovalProfile);
  const activeConversation = useChat((state) =>
    state.conversations.find((conversation) => conversation.id === state.activeId),
  );
  const rightPanelOpen = useSettings((state) => state.rightPanelOpen);
  const toggleRightPanel = useSettings((state) => state.toggleRightPanel);
  const setPaletteOpen = useSettings((state) => state.setPaletteOpen);
  const refresh = useChat((state) => state.refresh);
  const searchQuery = useChat((state) => state.searchQuery);
  const setSearchQuery = useChat((state) => state.setSearchQuery);
  const messageCount = useChat((state) =>
    state.activeId != null ? (state.messages[state.activeId]?.length ?? 0) : 0,
  );
  const stats = useCost((state) => state.stats);
  const refreshCost = useCost((state) => state.refresh);
  const monthlyBudgetUsd = useSettings((state) => state.monthlyBudgetUsd);
  const requestSettings = useSettings((state) => state.requestSettings);
  const monthUsd = currentMonthUsd(stats);
  const overBudget = monthUsd != null && monthlyBudgetUsd != null && monthUsd > monthlyBudgetUsd;

  // Refresh the cost chip once on mount (and each time a message completes).
  useEffect(() => {
    void refreshCost();
  }, [refreshCost, messageCount]);

  // Coding workspace folder: the agent fs tools, git and the terminal session
  // are all rooted at the conversation's project_path.
  const pickFolder = async () => {
    if (activeConversation == null) return;
    let folder: string | null = null;
    const selectFolder = bridge()?.selectFolder;
    if (selectFolder != null) {
      folder = await selectFolder();
    } else {
      // Browser/dev fallback: plain text prompt.
      folder = window.prompt(t("topbar.folder.prompt"), activeConversation.project_path ?? "");
    }
    if (folder == null || folder.trim().length === 0) return;
    await updateConversation(activeConversation.id, { project_path: folder.trim() });
    await refresh();
  };

  const switchMode = (id: "chat" | "coding") => {
    setMode(id);
    void updateConversationMode(id);
    setModeMenuOpen(false);
  };

  return (
    // Borderless header over the cream canvas (claude.ai has no hard top rule).
    <header className="flex h-14 shrink-0 items-center gap-3 bg-bg-0 px-4">
      {/* Brand button: shows PolyChat/PolyWork for the active mode and opens
          the mode switcher (requirement: no separate chat/coding pills). */}
      <div className="relative">
        <button
          type="button"
          onClick={() => setModeMenuOpen((current) => !current)}
          aria-expanded={modeMenuOpen}
          title={t("topbar.mode.toggle")}
          className={`flex h-9 items-center gap-2 rounded-lg px-2.5 text-[15px] font-semibold text-txt-0 transition ${
            modeMenuOpen ? "bg-bg-2" : "hover:bg-bg-2"
          }`}
        >
          <LogoMark className="h-6 w-6 text-accent" />
          {mode === "chat" ? t("topbar.polyChat") : t("topbar.polyWork")}
          <ChevronDownIcon className="h-4 w-4 text-txt-2" />
        </button>
        {modeMenuOpen && (
          <div className="absolute left-0 top-11 z-50 w-44 overflow-hidden rounded-xl border border-border bg-surface py-1 shadow-[var(--shadow-pop)]">
            {(
              [
                { id: "chat", label: t("topbar.polyChat"), hint: t("topbar.mode.chat"), Icon: ChatIcon },
                { id: "coding", label: t("topbar.polyWork"), hint: t("topbar.mode.coding"), Icon: CodeIcon },
              ] as const
            ).map(({ id, label, hint, Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => switchMode(id)}
                aria-pressed={mode === id}
                className={`flex w-full items-center gap-2.5 px-3 py-2 text-left transition hover:bg-bg-2 ${
                  mode === id ? "text-txt-0" : "text-txt-1"
                }`}
              >
                <Icon className={`h-4 w-4 ${mode === id ? "text-accent" : "text-txt-2"}`} />
                <span className="min-w-0">
                  <span className="block text-[13.5px] font-medium">{label}</span>
                  <span className="block text-[11px] text-txt-2">{hint}</span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex-1" />

      {/* Project folder + agent auto-approve (coding conversations only) */}
      {activeConversation?.mode === "coding" && (
        <button
          type="button"
          onClick={() => void pickFolder()}
          title={t("topbar.folder.hint")}
          className="mr-2 flex h-8 max-w-[280px] items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 text-[11.5px] text-txt-1 transition hover:bg-bg-2"
        >
          <FolderIcon className="h-3.5 w-3.5 shrink-0 text-accent" />
          <span className="truncate">
            {activeConversation.project_path ?? t("topbar.folder.select")}
          </span>
        </button>
      )}
      {activeConversation?.mode === "coding" && (
        <div className="relative mr-2">
          <button
            type="button"
            onClick={() => setAgentMenuOpen((current) => !current)}
            aria-expanded={agentMenuOpen}
            title={t("agent.settingsHint")}
            className={`flex h-8 items-center gap-1.5 rounded-full border px-2.5 text-[11.5px] transition ${
              activeConversation.agent_plan_mode
                ? "border-accent/50 bg-accent/10 text-txt-0"
                : "border-border bg-surface text-txt-1 hover:bg-bg-2"
            }`}
          >
            🔧 {t("agent.settings")}
          </button>
          {agentMenuOpen && (
            <div
              className="absolute right-0 top-10 z-50 w-64 overflow-hidden rounded-xl border border-border bg-surface py-1.5 shadow-[var(--shadow-pop)]"
              onMouseLeave={() => setAgentMenuOpen(false)}
            >
              <label className="flex cursor-pointer items-center gap-2 px-3 py-2 text-[12.5px] text-txt-1">
                <input
                  type="checkbox"
                  checked={activeConversation.agent_plan_mode}
                  onChange={(event) => void setPlanMode(event.target.checked)}
                  className="h-3 w-3 accent-[var(--accent)]"
                />
                {t("agent.planMode")}
                <span className="ml-auto text-[10.5px] text-txt-2">🧭</span>
              </label>
              <label className="flex cursor-pointer items-center gap-2 px-3 py-2 text-[12.5px] text-txt-1">
                <input
                  type="checkbox"
                  checked={activeConversation.agent_auto_approve}
                  onChange={(event) => void setAutoApprove(event.target.checked)}
                  className="h-3 w-3 accent-[var(--accent)]"
                />
                {t("agent.autoApprove")}
              </label>
              <div className="my-1 border-t border-border" />
              <div className="flex items-center gap-2 px-3 py-1.5 text-[12.5px] text-txt-1">
                {t("agent.approvalProfile")}
                <select
                  value={activeConversation.agent_approval_profile}
                  onChange={(event) =>
                    void setApprovalProfile(event.target.value as "all" | "mutating" | "git" | "never")
                  }
                  className="ml-auto h-7 rounded-md border border-border bg-bg-0 px-1.5 text-[11.5px] text-txt-0 focus:outline-none"
                >
                  <option value="all">{t("agent.profileAll")}</option>
                  <option value="mutating">{t("agent.profileMutating")}</option>
                  <option value="git">{t("agent.profileGit")}</option>
                  <option value="never">{t("agent.profileNever")}</option>
                </select>
              </div>
            </div>
          )}
        </div>
      )}

      {/* In-conversation message search (visible once there is history). */}
      {messageCount > 0 && (
        <div className="relative ml-auto hidden w-56 sm:block">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-txt-2" />
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder={t("topbar.searchMessages")}
            className="h-8 w-full rounded-lg border border-border bg-surface pl-9 pr-8 text-[12.5px] text-txt-0 outline-none placeholder:text-txt-2 focus:border-accent/40"
          />
          {searchQuery.length > 0 && (
            <button
              type="button"
              onClick={() => setSearchQuery("")}
              aria-label={t("common.clear")}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-1 text-txt-2 hover:text-txt-0"
            >
              ×
            </button>
          )}
        </div>
      )}
      <button
        type="button"
        onClick={() => setPaletteOpen(true)}
        aria-label={t("palette.placeholder")}
        title={t("palette.placeholder")}
        className="hidden h-9 items-center gap-2 rounded-lg border border-border bg-surface px-2.5 text-[12px] text-txt-2 transition hover:bg-bg-2 hover:text-txt-0 sm:flex"
      >
        <SearchIcon className="h-3.5 w-3.5" />
        <kbd className="rounded border border-border bg-bg-2 px-1 py-0.5 text-[9.5px]">⌘K</kbd>
      </button>

      {/* Monthly cost chip (budget-aware) */}
      <button
        type="button"
        onClick={() => requestSettings("cost")}
        title={t("settings.cost")}
        className={`flex h-8 items-center gap-1 rounded-full border px-2.5 text-[11.5px] tabular-nums transition ${
          overBudget
            ? "border-danger/50 bg-danger/10 text-danger"
            : "border-border bg-surface text-txt-2 hover:bg-bg-2 hover:text-txt-0"
        }`}
      >
        {overBudget && <span className="h-1.5 w-1.5 rounded-full bg-danger" />}
        {monthUsd != null ? `≈${formatCostUsd(monthUsd)}` : "—"}
      </button>

      {/* Right panel toggle */}
      <button
        type="button"
        onClick={toggleRightPanel}
        aria-pressed={rightPanelOpen}
        title={t("artifacts.title")}
        className={`flex h-9 w-9 items-center justify-center rounded-lg border transition ${
          rightPanelOpen
            ? "border-border bg-surface text-txt-0 shadow-[var(--shadow-card)]"
            : "border-transparent text-txt-2 hover:bg-bg-2 hover:text-txt-0"
        }`}
      >
        <PanelRightIcon className="h-4 w-4" />
      </button>
    </header>
  );
}
