import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  exportConversation,
  importConversation,
  searchMessages,
  type SearchHit,
} from "../../lib/api";
import {
  conversationToMarkdown,
  downloadText,
  parseConversationImport,
  safeFilename,
} from "../../lib/export";
import { useChat } from "../../stores/chat";
import { useConnection } from "../../stores/connection";
import { useModels } from "../../stores/models";
import { useSettings } from "../../stores/settings";
import { SUPPORTED_LANGUAGES, type AppLanguage } from "../../i18n";
import { Button } from "../ui/Button";
import { EditIcon, GearIcon, LogoMark, PanelLeftIcon, PlusIcon, SearchIcon } from "../ui/Icons";
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
  const setSearchQuery = useChat((state) => state.setSearchQuery);
  const remove = useChat((state) => state.remove);
  const rename = useChat((state) => state.rename);
  const setPinned = useChat((state) => state.setPinned);
  const models = useModels((state) => state.models);

  const [query, setQuery] = useState("");
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  /** Global message-content search (FTS5): hits grouped by conversation. */
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);

  useEffect(() => { void refresh(); }, [refresh]);

  const doExport = async (conversationId: string, format: "json" | "markdown") => {
    try {
      const detail = await exportConversation(conversationId);
      const filename = safeFilename(detail.conversation.title);
      if (format === "json") {
        downloadText(`${filename}.json`, JSON.stringify(detail, null, 2), "application/json");
      } else {
        downloadText(
          `${filename}.md`,
          conversationToMarkdown(detail.conversation, detail.messages),
          "text/markdown",
        );
      }
    } finally {
      setMenuFor(null);
    }
  };

  const doImport = async (file: File) => {
    setImporting(true);
    try {
      const text = await file.text();
      const parsed = parseConversationImport(text);
      if (parsed.messages.length === 0) return;
      const conversation = await importConversation({
        title: parsed.title,
        mode: parsed.json ? undefined : "chat",
        messages: parsed.messages,
      });
      await refresh();
      await open(conversation.id);
    } catch (err) {
      console.error("import failed", err);
    } finally {
      setImporting(false);
      if (importRef.current) importRef.current.value = "";
    }
  };

  // Debounced FTS5 message search; 3+ chars (trigram tokenizer minimum).
  useEffect(() => {
    const needle = query.trim();
    if (needle.length < 3) {
      setHits([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = setTimeout(() => {
      void searchMessages(needle, 25)
        .then((results) => setHits(results))
        .catch(() => setHits([]))
        .finally(() => setSearching(false));
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  // Ctrl/Cmd+Shift+F focuses the global message search.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (menuFor == null) return;
    const close = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("[data-chat-menu]")) return;
      setMenuFor(null);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [menuFor]);

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

  const searchResults = useMemo(() => {
    const groups = new Map<string, { title: string; hits: SearchHit[] }>();
    for (const hit of hits) {
      const group = groups.get(hit.conversation_id) ?? {
        title: hit.conversation_title ?? t("sidebar.untitled"),
        hits: [],
      };
      group.hits.push(hit);
      groups.set(hit.conversation_id, group);
    }
    return [...groups.values()];
  }, [hits, t]);

  const openHit = (hit: SearchHit) => {
    void open(hit.conversation_id);
    setSearchQuery(hit.snippet.length > 0 ? query.trim() : "");
    setQuery("");
    setHits([]);
  };

  if (sidebarCollapsed) {
    return (
      <aside className="flex w-[60px] shrink-0 flex-col items-center gap-1 border-r border-border bg-bg-1 py-4 transition-all duration-200">
        <button type="button" onClick={toggleSidebar} title={t("sidebar.expand")} aria-label={t("sidebar.expand")} className="flex h-9 w-9 items-center justify-center rounded-lg text-txt-1 transition hover:bg-bg-2 hover:text-txt-0"><PanelLeftIcon className="h-[18px] w-[18px]" /></button>
        <button type="button" onClick={() => void newConversation(lastModelId)} title={t("sidebar.newChat")} aria-label={t("sidebar.newChat")} className="flex h-9 w-9 items-center justify-center rounded-lg text-txt-1 transition hover:bg-bg-2 hover:text-txt-0"><PlusIcon className="h-[18px] w-[18px]" /></button>
        <div className="flex-1" />
        <button type="button" onClick={() => setSettingsOpen(true)} title={t("sidebar.settings")} aria-label={t("sidebar.settings")} className="flex h-9 w-9 items-center justify-center rounded-lg text-txt-2 transition hover:bg-bg-2 hover:text-txt-0"><GearIcon className="h-4 w-4" /></button>
        <span className={`mt-1 h-2 w-2 rounded-full ${status === "online" ? "bg-success" : status === "connecting" ? "bg-warn" : "bg-danger"}`} aria-hidden />
      </aside>
    );
  }

  return (
    <aside className="flex w-[264px] shrink-0 flex-col border-r border-border bg-bg-1 transition-all duration-200">
      <div className="flex items-center gap-2.5 px-4 pb-2 pt-4">
        <LogoMark className="h-7 w-7 text-accent" />
        <span className="flex-1 text-[15px] font-semibold tracking-tight">PolyLab</span>
        <button type="button" onClick={toggleSidebar} title={t("sidebar.collapse")} aria-label={t("sidebar.collapse")} className="flex h-8 w-8 items-center justify-center rounded-lg text-txt-2 transition hover:bg-bg-2 hover:text-txt-0"><PanelLeftIcon className="h-4 w-4" /></button>
        <button type="button" title={t("sidebar.settings")} aria-label={t("sidebar.settings")} onClick={() => setSettingsOpen(true)} className="flex h-8 w-8 items-center justify-center rounded-lg text-txt-2 transition hover:bg-bg-2 hover:text-txt-0"><GearIcon className="h-4 w-4" /></button>
      </div>
      <div className="px-3 pt-2">
        <div className="flex gap-1.5">
          <Button variant="subtle" size="sm" className="flex-1 justify-start" onClick={() => void newConversation(lastModelId)}><PlusIcon className="h-4 w-4" />{t("sidebar.newChat")}</Button>
          <input
            ref={importRef}
            type="file"
            accept=".json,.md,.markdown,application/json,text/markdown"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file != null) void doImport(file);
            }}
          />
          <Button variant="subtle" size="sm" onClick={() => importRef.current?.click()} disabled={importing} title={t("sidebar.import")}>
            {importing ? "…" : "⤴"}
          </Button>
        </div>
        <div className="relative mt-2">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-txt-2" />
          <input
            ref={searchRef}
            id="sidebar-message-search"
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setQuery("");
                setHits([]);
              }
            }}
            placeholder={t("sidebar.searchPlaceholder")}
            className="h-8 w-full rounded-lg border border-border bg-surface pl-9 pr-3 text-[13px] text-txt-0 placeholder:text-txt-2 focus:border-txt-2/40 focus:outline-none"
          />
          {query.length > 0 && (
            <button
              type="button"
              aria-label={t("common.clear")}
              onClick={() => {
                setQuery("");
                setHits([]);
              }}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-1 text-txt-2 hover:text-txt-0"
            >
              ×
            </button>
          )}
        </div>
      </div>
      <div className="mt-5 flex min-h-0 flex-1 flex-col px-3">
        <div className="px-1 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-txt-2">
          {mode === "coding" ? t("sidebar.codingConversations") : t("sidebar.conversations")}
        </div>
        <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto pb-2">
          {query.trim().length >= 3 && (
            <div className="space-y-2 pb-1" data-testid="search-results">
              {searching && searchResults.length === 0 && (
                <div className="px-2 py-3 text-center text-[12px] text-txt-2">
                  {t("sidebar.searching")}
                </div>
              )}
              {!searching && searchResults.length === 0 && (
                <div className="px-2 py-3 text-center text-[12px] text-txt-2">
                  {t("sidebar.noMessageMatches")}
                </div>
              )}
              {searchResults.map((group) => (
                <div key={group.hits[0].conversation_id}>
                  <div className="px-1 pb-1 text-[11px] font-semibold text-txt-2">
                    {group.title}
                    <span className="ml-1 font-normal">· {group.hits.length}</span>
                  </div>
                  <div className="space-y-0.5">
                    {group.hits.map((hit) => (
                      <button
                        key={hit.message_id}
                        type="button"
                        onClick={() => openHit(hit)}
                        className="block w-full rounded-lg px-2 py-1.5 text-left transition hover:bg-bg-2"
                      >
                        <span className="block truncate text-[12px] text-txt-1">
                          {hit.role === "user" ? "🧑 " : "🤖 "}
                          {hit.snippet}
                        </span>
                        <span className="block text-[10.5px] text-txt-2">
                          {new Date(hit.created_at).toLocaleDateString()}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
          {query.trim().length < 3 && filtered.map((conversation) => {
            const active = conversation.id === activeId;
            const model = models.find((entry) => entry.id === conversation.model_id);
            return (
              <div key={conversation.id} className={`group flex items-center rounded-lg transition ${active ? "bg-bg-3" : "hover:bg-bg-2"}`}>
                {renaming === conversation.id ? (
                  <input autoFocus value={renameValue} onChange={(event) => setRenameValue(event.target.value)} onBlur={() => { const value = renameValue.trim(); setRenaming(null); if (value.length > 0) void rename(conversation.id, value); }} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") setRenaming(null); }} className="my-1 w-full rounded-md border border-accent/50 bg-bg-0 px-2 py-1 text-[13px] text-txt-0 focus:outline-none" />
                ) : (
                  <>
                    <button type="button" onClick={() => void open(conversation.id)} onDoubleClick={() => { setRenaming(conversation.id); setRenameValue(conversation.title ?? ""); }} title={t("sidebar.renameHint")} className="min-w-0 flex-1 px-2.5 py-2 text-left">
                      <span className={`block truncate text-[13px] ${active ? "text-txt-0" : "text-txt-1"}`}>{conversation.pinned && <span aria-label="Pinned">● </span>}{conversation.title ?? t("sidebar.untitled")}</span>
                      {model != null && <span className="block truncate text-[11px] text-txt-2">{model.display_name}</span>}
                    </button>
                    <button type="button" title={t("sidebar.rename")} aria-label={t("sidebar.rename")} onClick={() => { setRenaming(conversation.id); setRenameValue(conversation.title ?? ""); }} className="hidden h-7 w-7 shrink-0 items-center justify-center rounded-md text-txt-2 transition hover:bg-border hover:text-txt-0 group-hover:flex"><EditIcon className="h-3.5 w-3.5" /></button>
                    <div data-chat-menu className="relative mr-1.5">
                      <button type="button" title={t("sidebar.chatMenu")} aria-label={t("sidebar.chatMenu")} onClick={(event) => { event.stopPropagation(); setMenuFor(menuFor === conversation.id ? null : conversation.id); }} className="hidden h-7 w-7 items-center justify-center rounded-md text-txt-2 transition hover:bg-border group-hover:flex">⋯</button>
                      {menuFor === conversation.id && (
                        <div data-chat-menu className="absolute right-0 top-8 z-50 w-40 overflow-hidden rounded-lg border border-border bg-surface py-1 shadow-[var(--shadow-pop)]">
                          <button type="button" className="block w-full px-3 py-1.5 text-left text-[12.5px] text-txt-1 hover:bg-bg-2" onClick={() => { setRenaming(conversation.id); setRenameValue(conversation.title ?? ""); setMenuFor(null); }}>{t("sidebar.rename")}</button>
                          <button type="button" className="block w-full px-3 py-1.5 text-left text-[12.5px] text-txt-1 hover:bg-bg-2" onClick={async () => { try { await setPinned(conversation.id, !conversation.pinned); } finally { setMenuFor(null); } }}>{conversation.pinned ? t("sidebar.unpin") : t("sidebar.pin")}</button>
                          <button type="button" className="block w-full px-3 py-1.5 text-left text-[12.5px] text-txt-1 hover:bg-bg-2" onClick={() => { void doExport(conversation.id, "json"); }}>{t("sidebar.exportJson")}</button>
                          <button type="button" className="block w-full px-3 py-1.5 text-left text-[12.5px] text-txt-1 hover:bg-bg-2" onClick={() => { void doExport(conversation.id, "markdown"); }}>{t("sidebar.exportMarkdown")}</button>
                          <button type="button" className="block w-full px-3 py-1.5 text-left text-[12.5px] text-danger hover:bg-bg-2" onClick={async () => { try { await remove(conversation.id); } finally { setMenuFor(null); } }}>{t("sidebar.deleteChat")}</button>
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            );
          })}
          {loaded && filtered.length === 0 && <div className="whitespace-pre-line rounded-lg px-2 py-3 text-[13px] leading-relaxed text-txt-2">{query.trim().length > 0 ? t("sidebar.noMatches") : t("sidebar.noConversations")}</div>}
        </div>
      </div>
      <div className="space-y-3 border-t border-border px-4 py-3">
        <div className="flex items-center justify-between"><span className="text-[11px] font-semibold uppercase tracking-wider text-txt-2">{t("sidebar.language")}</span><div className="flex overflow-hidden rounded-full border border-border bg-surface p-0.5">{SUPPORTED_LANGUAGES.map((code: AppLanguage) => <button key={code} type="button" onClick={() => setLanguage(code)} aria-pressed={language === code} className={`h-5 rounded-full px-2.5 text-[11px] font-semibold uppercase transition ${language === code ? "bg-bg-invert text-txt-invert" : "text-txt-2 hover:bg-bg-2 hover:text-txt-0"}`}>{code}</button>)}</div></div>
        <div className="flex items-center justify-between"><StatusBadge />{coreVersion != null && <span className="text-[11px] tabular-nums text-txt-2">v{coreVersion}</span>}</div>
      </div>
    </aside>
  );
}
