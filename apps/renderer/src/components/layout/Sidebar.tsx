import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { useChat } from "../../stores/chat";
import { useConnection } from "../../stores/connection";
import { useModels } from "../../stores/models";
import { useSettings } from "../../stores/settings";
import { SUPPORTED_LANGUAGES, type AppLanguage } from "../../i18n";
import { Button } from "../ui/Button";
import { GearIcon, LogoMark, PanelLeftIcon, PlusIcon, SearchIcon } from "../ui/Icons";
import { StatusBadge } from "../ui/StatusBadge";

export function Sidebar() {
  const { t } = useTranslation();
  const language = useSettings((state) => state.language);
  const setLanguage = useSettings((state) => state.setLanguage);
  const setSettingsOpen = useSettings((state) => state.setSettingsOpen);
  const sidebarCollapsed = useSettings((state) => state.sidebarCollapsed);
  const toggleSidebar = useSettings((state) => state.toggleSidebar);
  const lastModelId = useSettings((state) => state.lastModelId);
  const coreVersion = useConnection((state) => state.coreVersion);
  const status = useConnection((state) => state.status);

  const mode = useSettings((state) => state.mode);
  const conversations = useChat((state) => state.conversations);
  const activeId = useChat((state) => state.activeId);
  const loaded = useChat((state) => state.loaded);
  const refresh = useChat((state) => state.refresh);
  const newConversation = useChat((state) => state.newConversation);
  const open = useChat((state) => state.open);
  const remove = useChat((state) => state.remove);
  const rename = useChat((state) => state.rename);
  const setPinned = useChat((state) => state.setPinned);
  const refreshConversations = useChat((state) => state.refresh);
  const models = useModels((state) => state.models);

  const [query, setQuery] = useState("");
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (menuFor == null) return;
    const close = () => setMenuFor(null);
    window.addEventListener("mousedown", (close as EventListener), { once: true });
    return () => window.removeEventListener("mousedown", close as EventListener);
  }, [menuFor]);

  useEffect(() => {
    void refreshConversations();
  }, [refreshConversations]);

  const filtered = useMemo(() => {
    // The sidebar follows the global Chat/Coding switch: each mode keeps its
    // own conversation list.
    const forMode = conversations.filter((conversation) => conversation.mode === mode);
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return forMode;
    return forMode.filter((conversation) =>
      (conversation.title ?? "").toLowerCase().includes(needle),
    );
  }, [conversations, mode, query]);

  if (sidebarCollapsed) {
    return (
      <aside className="flex w-[60px] shrink-0 flex-col items-center gap-1 border-r border-border bg-bg-1 py-4 transition-all duration-200">
        <button
          type="button"
          onClick={toggleSidebar}
          title={t("sidebar.expand")}
          aria-label={t("sidebar.expand")}
          className="flex h-9 w-9 items-center justify-center rounded-lg text-txt-1 transition hover:bg-bg-2 hover:text-txt-0"
        >
          <PanelLeftIcon className="h-[18px] w-[18px]" />
        </button>
        <button
          type="button"
          onClick={() => void newConversation(lastModelId)}
          title={t("sidebar.newChat")}
          aria-label={t("sidebar.newChat")}
          className="flex h-9 w-9 items-center justify-center rounded-lg text-txt-1 transition hover:bg-bg-2 hover:text-txt-0"
        >
          <PlusIcon className="h-[18px] w-[18px]" />
        </button>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          title={t("sidebar.settings")}
          aria-label={t("sidebar.settings")}
          className="flex h-9 w-9 items-center justify-center rounded-lg text-txt-2 transition hover:bg-bg-2 hover:text-txt-0"
        >
          <GearIcon className="h-4 w-4" />
        </button>
        <span
          className={`mt-1 h-2 w-2 rounded-full ${
            status === "online" ? "bg-success" : status === "connecting" ? "bg-warn" : "bg-danger"
          }`}
          aria-hidden
        />
      </aside>
    );
  }

  return (
    <aside className="flex w-[264px] shrink-0 flex-col border-r border-border bg-bg-1 transition-all duration-200">
      {/* Brand + collapse */}
      <div className="flex items-center gap-2.5 px-4 pb-2 pt-4">
        <LogoMark className="h-7 w-7 text-accent" />
        <span className="flex-1 text-[15px] font-semibold tracking-tight">PolyLab</span>
        <button
          type="button"
          onClick={toggleSidebar}
          title={t("sidebar.collapse")}
          aria-label={t("sidebar.collapse")}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-txt-2 transition hover:bg-bg-2 hover:text-txt-0"
        >
          <PanelLeftIcon className="h-4 w-4" />
        </button>
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
            className="h-8 w-full rounded-lg border border-border bg-surface pl-9 pr-3 text-[13px] text-txt-0
              placeholder:text-txt-2 focus:border-txt-2/40 focus:outline-none"
          />
        </div>
      </div>

      {/* Conversation list */}
      <div className="mt-5 flex min-h-0 flex-1 flex-col px-3">
        <div className="px-1 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-txt-2">
          {mode === "coding" ? t("sidebar.codingConversations") : t("sidebar.conversations")}
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
                {renaming === conversation.id ? (
                  <input
                    autoFocus
                    value={renameValue}
                    onChange={(event) => setRenameValue(event.target.value)}
                    onBlur={() => {
                      if (renameValue.trim().length > 0) void rename(conversation.id, renameValue.trim());
                      setRenaming(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                      if (event.key === "Escape") setRenaming(null);
                    }}
                    className="my-1 w-full rounded-md border border-accent/50 bg-bg-0 px-2 py-1 text-[13px] text-txt-0 focus:outline-none"
                  />
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => void open(conversation.id)}
                      onDoubleClick={() => {
                        setRenaming(conversation.id);
                        setRenameValue(conversation.title ?? "");
                      }}
                      className="min-w-0 flex-1 px-2.5 py-2 text-left"
                    >
                      <span
                        className={`block truncate text-[13px] ${
                          active ? "text-txt-0" : "text-txt-1"
                        }`}
                      >
                        {conversation.pinned && "📌 "}
                        {conversation.title ?? t("sidebar.untitled")}
                      </span>
                      {model != null && (
                        <span className="block truncate text-[11px] text-txt-2">
                          {model.display_name}
                        </span>
                      )}
                    </button>
                    <div className="relative mr-1.5">
                      <button
                        type="button"
                        title={t("sidebar.chatMenu")}
                        aria-label={t("sidebar.chatMenu")}
                        onClick={() => setMenuFor(menuFor === conversation.id ? null : conversation.id)}
                        className="hidden h-7 w-7 items-center justify-center rounded-md text-txt-2 transition hover:bg-border group-hover:flex"
                      >
                        ⋯
                      </button>
                      {menuFor === conversation.id && (
                        <div className="absolute right-0 top-8 z-50 w-40 overflow-hidden rounded-lg border border-border bg-surface py-1 shadow-[var(--shadow-pop)]">
                          <button
                            type="button"
                            className="block w-full px-3 py-1.5 text-left text-[12.5px] text-txt-1 hover:bg-bg-2"
                            onClick={() => {
                              setRenaming(conversation.id);
                              setRenameValue(conversation.title ?? "");
                              setMenuFor(null);
                            }}
                          >
                            {t("sidebar.rename")}
                          </button>
                          <button
                            type="button"
                            className="block w-full px-3 py-1.5 text-left text-[12.5px] text-txt-1 hover:bg-bg-2"
                            onClick={() => {
                              void setPinned(conversation.id, !conversation.pinned);
                              setMenuFor(null);
                            }}
                          >
                            {conversation.pinned ? t("sidebar.unpin") : t("sidebar.pin")}
                          </button>
                          <button
                            type="button"
                            className="block w-full px-3 py-1.5 text-left text-[12.5px] text-danger hover:bg-bg-2"
                            onClick={() => {
                              void remove(conversation.id);
                              setMenuFor(null);
                            }}
                          >
                            {t("sidebar.deleteChat")}
                          </button>
                        </div>
                      )}
                    </div>
                  </>
                )}
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
          <div className="flex overflow-hidden rounded-full border border-border bg-surface p-0.5">
            {SUPPORTED_LANGUAGES.map((code: AppLanguage) => (
              <button
                key={code}
                type="button"
                onClick={() => setLanguage(code)}
                aria-pressed={language === code}
                className={`h-5 rounded-full px-2.5 text-[11px] font-semibold uppercase transition ${
                  language === code
                    ? "bg-bg-invert text-txt-invert"
                    : "text-txt-2 hover:bg-bg-2 hover:text-txt-0"
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
