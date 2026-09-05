import { useTranslation } from "react-i18next";

import { LogoMark } from "../ui/Icons";

function greetingKey(date: Date): string {
  const hour = date.getHours();
  if (hour < 6) return "chat.greeting.night";
  if (hour < 12) return "chat.greeting.morning";
  if (hour < 18) return "chat.greeting.afternoon";
  return "chat.greeting.evening";
}

/** claude.ai-style welcome: terracotta ✻, serif greeting, quiet chips. */
export function EmptyState() {
  const { t } = useTranslation();

  const capabilities = [
    t("chat.capabilities.single"),
    t("chat.capabilities.groups"),
    t("chat.capabilities.coding"),
  ];

  return (
    <div className="flex h-full flex-col items-center justify-center px-8 text-center">
      <LogoMark className="mb-6 h-10 w-10 text-accent" />
      <h1 className="font-serif text-[32px] font-normal leading-tight tracking-tight text-txt-0">
        {t(greetingKey(new Date()))}
      </h1>
      <p className="mt-3 max-w-md text-[14px] leading-relaxed text-txt-1">{t("app.tagline")}</p>

      <div className="mt-7 flex flex-wrap items-center justify-center gap-2 text-[12px] text-txt-2">
        {capabilities.map((capability) => (
          <span
            key={capability}
            className="rounded-full border border-border bg-white px-3 py-1.5 shadow-[0_1px_2px_rgba(31,30,29,0.05)]"
          >
            {capability}
          </span>
        ))}
      </div>

      <p className="mt-8 max-w-md text-[12.5px] leading-relaxed text-txt-2">{t("chat.emptyHint")}</p>
    </div>
  );
}
