import { useTranslation } from "react-i18next";

import { useSettings } from "../../stores/settings";
import { ModelPicker } from "../models/ModelPicker";
import { ChatIcon, ChevronDownIcon, CodeIcon, LogoMark, PanelRightIcon } from "../ui/Icons";

export function TopBar() {
  const { t } = useTranslation();
  const mode = useSettings((state) => state.mode);
  const setMode = useSettings((state) => state.setMode);
  const rightPanelOpen = useSettings((state) => state.rightPanelOpen);
  const toggleRightPanel = useSettings((state) => state.toggleRightPanel);

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-bg-0 px-4">
      {/* Workspace switcher (static for now) */}
      <button
        type="button"
        className="flex h-9 items-center gap-2 rounded-lg px-2.5 text-[15px] font-semibold text-txt-0 transition hover:bg-bg-2"
      >
        <LogoMark className="h-6 w-6" />
        {t("topbar.workspace")}
        <ChevronDownIcon className="h-4 w-4 text-txt-2" />
      </button>

      {/* Chat / Coding segmented control */}
      <div className="ml-4 flex h-9 items-center rounded-lg border border-border bg-bg-1 p-0.5">
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
              onClick={() => setMode(id)}
              aria-pressed={active}
              title={t("topbar.mode.comingSoon", { mode: label })}
              className={`flex h-8 items-center gap-1.5 rounded-[7px] px-3 text-[13px] font-medium transition ${
                active ? "bg-bg-3 text-txt-0" : "text-txt-2 hover:text-txt-1"
              }`}
            >
              <Icon className="h-4 w-4" />
              {label}
            </button>
          );
        })}
      </div>

      <div className="flex-1" />

      <ModelPicker />

      {/* Right panel toggle */}
      <button
        type="button"
        onClick={toggleRightPanel}
        aria-pressed={rightPanelOpen}
        title={t("artifacts.title")}
        className={`flex h-9 w-9 items-center justify-center rounded-lg border border-border transition ${
          rightPanelOpen ? "bg-bg-3 text-txt-0" : "bg-bg-1 text-txt-2 hover:text-txt-0"
        }`}
      >
        <PanelRightIcon className="h-4 w-4" />
      </button>
    </header>
  );
}
