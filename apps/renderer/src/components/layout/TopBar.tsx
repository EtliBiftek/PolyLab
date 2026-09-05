import { useTranslation } from "react-i18next";

import { useChat } from "../../stores/chat";
import { useSettings } from "../../stores/settings";
import { ChatIcon, ChevronDownIcon, CodeIcon, LogoMark, PanelRightIcon } from "../ui/Icons";

export function TopBar() {
  const { t } = useTranslation();
  const mode = useSettings((state) => state.mode);
  const setMode = useSettings((state) => state.setMode);
  const updateConversationMode = useChat((state) => state.updateMode);
  const setAutoApprove = useChat((state) => state.setAutoApprove);
  const activeConversation = useChat((state) =>
    state.conversations.find((conversation) => conversation.id === state.activeId),
  );
  const rightPanelOpen = useSettings((state) => state.rightPanelOpen);
  const toggleRightPanel = useSettings((state) => state.toggleRightPanel);

  return (
    // Borderless header over the cream canvas (claude.ai has no hard top rule).
    <header className="flex h-14 shrink-0 items-center gap-3 bg-bg-0 px-4">
      {/* Workspace switcher (static for now) */}
      <button
        type="button"
        className="flex h-9 items-center gap-2 rounded-lg px-2.5 text-[15px] font-semibold text-txt-0 transition hover:bg-bg-2"
      >
        <LogoMark className="h-6 w-6 text-accent" />
        {t("topbar.workspace")}
        <ChevronDownIcon className="h-4 w-4 text-txt-2" />
      </button>

      {/* Chat / Coding segmented control — claude.ai pill: cream track, white active */}
      <div className="ml-3 flex h-9 items-center rounded-full bg-bg-2 p-0.5">
        {(
          [
            { id: "chat", label: t("topbar.mode.chat"), Icon: ChatIcon },
            { id: "coding", label: t("topbar.mode.coding"), Icon: CodeIcon },
          ] as const
        ).map(({ id, label, Icon }) => {
          const active = mode === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => {
                setMode(id);
                void updateConversationMode(id);
              }}
              aria-pressed={active}
              title={t("topbar.mode.comingSoon", { mode: label })}
              className={`flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-medium transition ${
                active
                  ? "bg-surface text-txt-0 shadow-[var(--shadow-card)]"
                  : "text-txt-1 hover:text-txt-0"
              }`}
            >
              <Icon className={`h-4 w-4 ${active ? "text-accent" : ""}`} />
              {label}
            </button>
          );
        })}
      </div>

      <div className="flex-1" />

      {/* Agent auto-approve (coding conversations only) */}
      {activeConversation?.mode === "coding" && (
        <label
          className="mr-2 flex cursor-pointer items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1 text-[11.5px] text-txt-1"
          title={t("agent.autoApproveHint")}
        >
          <input
            type="checkbox"
            checked={activeConversation.agent_auto_approve}
            onChange={(event) => void setAutoApprove(event.target.checked)}
            className="h-3 w-3 accent-[var(--accent)]"
          />
          {t("agent.autoApprove")}
        </label>
      )}

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
