import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { useChat } from "../../stores/chat";
import { useConnection } from "../../stores/connection";
import { useModels } from "../../stores/models";
import { useSettings } from "../../stores/settings";
import { SUPPORTED_LANGUAGES, type AppLanguage } from "../../i18n";
import { Button } from "../ui/Button";
import { GearIcon, LogoMark, PlusIcon, SearchIcon, TrashIcon } from "../ui/Icons";
import { StatusBadge } from "../ui/StatusBadge";

export function Sidebar() {
  const { t } = useTranslation();
  const language = useSettings((state) => state.language);
  const setLanguage = useSettings((state) => state.setLanguage);
  const setSettingsOpen = useSettings((state) => state.setSettingsOpen);
  const lastModelId = useSettings((state) => state.lastModelId);
  const coreVersion = useConnection((state) => state.coreVersion);

  const conversations = useChat((state) => state.conversations);
  const activeId = useChat((state) => state.activeId);
  const loaded = useChat((state) => state.loaded);
  const refresh = useChat((state) => state.refresh);
  const newConversation = useChat((state) => state.newConversation);
  const open = useChat((state) => state.open);
  const remove = useChat((state) => state.remove);
  const models = useModels((state) => state.models);

  const [query, setQuery] = useState("");

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return conversations;
    return conversations.filter((conversation) =>
      (conversation.title ?? "").toLowerCase().includes(needle),
    );
  }, [conversations, query]);

  return (
    <aside className="flex w-[264px] shrink-0 flex-col border-r border-border bg-bg-1">
      {/* Brand */}
      <div className="flex items-center gap-2.5 px-4 pb-2 pt-4">
        <LogoMark className="h-7 w-7" />
        <span className="flex-1 text-[15px] font-semibold tracking-tight">PolyLab</span>
        <button
          type="button"
          title={t("sidebar.settings")}
          aria-label={t("sidebar.settings")}
          onClick={() => setSettingsOpen(true)}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-txt-2 transition hover:bg-bg-2 hover:text-txt-0"
        >
          <GearIcon className="h-4 w-4" />
        </button>
      </div>

      {/* Actions */}
      <div className="px-3 pt-2">
        <Button
          variant="subtle"
          size="sm"
          className="w-full justify-start"
          onClick={() => void newConversation(lastModelId)}
        >
          <PlusIcon className="h-4 w-4" />
          {t("sidebar.newChat")}
        </Button>

        <div className="relative mt-2">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-txt-2" />
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("sidebar.searchPlaceholder")}
            className="h-8 w-full rounded-lg border border-border bg-bg-2 pl-9 pr-3 text-[13px] text-txt-0
              placeholder:text-txt-2 focus:border-txt-2/40 focus:outline-none"
          />
        </div>
      </div>

      {/* Conversation list */}
      <div className="mt-5 flex min-h-0 flex-1 flex-col px-3">
        <div className="px-1 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-txt-2">
          {t("sidebar.conversations")}
        </div>
        <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto pb-2">
          {filtered.map((conversation) => {
            const active = conversation.id === activeId;
            const model = models.find((entry) => entry.id === conversation.model_id);
            return (
              <div
                key={conversation.id}
                className={`group flex items-center rounded-lg transition ${
                  active ? "bg-bg-3" : "hover:bg-bg-2"
                }`}
              >
                <button
                  type="button"
                  onClick={() => void open(conversation.id)}
                  className="min-w-0 flex-1 px-2.5 py-2 text-left"
                >
                  <span
                    className={`block truncate text-[13px] ${
                      active ? "text-txt-0" : "text-txt-1"
                    }`}
                  >
                    {conversation.title ?? t("sidebar.untitled")}
                  </span>
                  {model != null && (
                    <span className="block truncate text-[11px] text-txt-2">
                      {model.display_name}
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  title={t("sidebar.deleteChat")}
                  aria-label={t("sidebar.deleteChat")}
                  onClick={() => void remove(conversation.id)}
                  className="mr-1.5 hidden h-7 w-7 items-center justify-center rounded-md text-txt-2 transition hover:bg-border hover:text-danger group-hover:flex"
                >
                  <TrashIcon className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}
          {loaded && filtered.length === 0 && (
            <div className="whitespace-pre-line rounded-lg px-2 py-3 text-[13px] leading-relaxed text-txt-2">
              {query.trim().length > 0
                ? t("sidebar.noMatches")
                : t("sidebar.noConversations")}
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="space-y-3 border-t border-border px-4 py-3">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-txt-2">
            {t("sidebar.language")}
          </span>
          <div className="flex overflow-hidden rounded-md border border-border">
            {SUPPORTED_LANGUAGES.map((code: AppLanguage) => (
              <button
                key={code}
                type="button"
                onClick={() => setLanguage(code)}
                aria-pressed={language === code}
                className={`h-6 px-2.5 text-[11px] font-semibold uppercase transition ${
                  language === code ? "accent-gradient text-white" : "bg-bg-2 text-txt-2 hover:text-txt-0"
                }`}
              >
                {code}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between">
          <StatusBadge />
          {coreVersion != null && (
            <span className="text-[11px] tabular-nums text-txt-2">v{coreVersion}</span>
          )}
        </div>
      </div>
    </aside>
  );
}
