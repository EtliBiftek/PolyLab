import { useTranslation } from "react-i18next";

import { useSettings } from "../../stores/settings";
import { CloseIcon } from "../ui/Icons";

/** Artifacts / coding side panel — populated from Phase 3 (artifacts) and Phase 4 (files). */
export function RightPanel() {
  const { t } = useTranslation();
  const toggleRightPanel = useSettings((s) => s.toggleRightPanel);

  return (
    <aside className="flex w-[380px] shrink-0 flex-col border-l border-border bg-white">
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
        <span className="text-[13px] font-semibold text-txt-0">{t("artifacts.title")}</span>
        <button
          type="button"
          onClick={toggleRightPanel}
          title={t("common.close")}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-txt-2 transition hover:bg-bg-2 hover:text-txt-0"
        >
          <CloseIcon className="h-4 w-4" />
        </button>
      </div>
      <div className="flex flex-1 items-center justify-center px-8">
        <p className="text-center text-[13px] leading-relaxed text-txt-2">{t("artifacts.empty")}</p>
      </div>
    </aside>
  );
}
