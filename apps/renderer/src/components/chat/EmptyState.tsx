import { useTranslation } from "react-i18next";

import { LogoMark } from "../ui/Icons";

export function EmptyState() {
  const { t } = useTranslation();

  const capabilities = [
    t("chat.capabilities.single"),
    t("chat.capabilities.groups"),
    t("chat.capabilities.coding"),
  ];

  return (
    <div className="flex h-full flex-col items-center justify-center px-8 text-center">
      <LogoMark className="mb-5 h-14 w-14 drop-shadow-[0_4px_24px_rgba(196,49,75,0.35)]" />
      <h1 className="text-xl font-semibold tracking-tight">{t("chat.emptyTitle")}</h1>
      <p className="mt-2 max-w-md text-sm leading-relaxed text-txt-1">{t("app.tagline")}</p>

      <div className="mt-6 flex flex-wrap items-center justify-center gap-2 text-[12px] text-txt-2">
        {capabilities.map((capability, index) => (
          <span key={capability} className="flex items-center gap-2">
            {index > 0 && <span className="h-1 w-1 rounded-full bg-txt-2/60" aria-hidden />}
            <span className="rounded-full border border-border bg-bg-1 px-3 py-1">{capability}</span>
          </span>
        ))}
      </div>

      <p className="mt-8 max-w-md text-[12.5px] leading-relaxed text-txt-2">{t("chat.emptyHint")}</p>
    </div>
  );
}
