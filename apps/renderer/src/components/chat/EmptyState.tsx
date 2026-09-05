import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { useChat } from "../../stores/chat";
import { useSuggestions } from "../../stores/suggestions";
import { LogoMark } from "../ui/Icons";

function greetingKey(date: Date): string {
  const hour = date.getHours();
  if (hour < 6) return "chat.greeting.night";
  if (hour < 12) return "chat.greeting.morning";
  if (hour < 18) return "chat.greeting.afternoon";
  return "chat.greeting.evening";
}

/**
 * claude.ai-style welcome: terracotta/red ✻, serif greeting, and 3 suggestion
 * chips that rotate per new chat, differ by chat/coding mode, and are seeded
 * from the user's conversation history.
 */
export function EmptyState() {
  const { t } = useTranslation();
  const { i18n } = useTranslation();
  const mode = useChat((state) =>
    state.conversations.find((conversation) => conversation.id === state.activeId)?.mode ?? "chat",
  );
  const conversationCount = useChat((state) => state.conversations.length);
  const historySeed = useChat((state) =>
    state.conversations
      .slice(0, 5)
      .map((conversation) => conversation.title ?? conversation.id)
      .join("|"),
  );
  const suggestions = useSuggestions((state) => state.current);
  const refreshSuggestions = useSuggestions((state) => state.refresh);

  useEffect(() => {
    refreshSuggestions(mode, i18n.language, `${historySeed}#${conversationCount}`);
  }, [mode, i18n.language, historySeed, conversationCount, refreshSuggestions]);

  return (
    <div className="flex h-full flex-col items-center justify-center px-8 pb-40 text-center">
      <LogoMark className="mb-6 h-10 w-10 text-accent" />
      <h1 className="font-serif text-[32px] font-normal leading-tight tracking-tight text-txt-0">
        {t(greetingKey(new Date()))}
      </h1>
      <p className="mt-3 max-w-md text-[14px] leading-relaxed text-txt-1">{t("app.tagline")}</p>

      <div className="mt-8 flex w-full max-w-2xl flex-col gap-2" data-testid="suggestions">
        {suggestions.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            onClick={() => {
              window.dispatchEvent(
                new CustomEvent("polylab:suggest", { detail: suggestion }),
              );
            }}
            className="rounded-xl border border-border bg-surface px-4 py-3 text-left text-[13.5px] text-txt-1 shadow-[var(--shadow-card)] transition hover:border-accent/40 hover:text-txt-0"
          >
            {suggestion}
          </button>
        ))}
      </div>

      <p className="mt-8 max-w-md text-[12.5px] leading-relaxed text-txt-2">{t("chat.emptyHint")}</p>
    </div>
  );
}
