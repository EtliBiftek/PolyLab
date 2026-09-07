import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useChat } from "../../stores/chat";
import { useModels } from "../../stores/models";
import { useSettings } from "../../stores/settings";
import { ChatIcon, CodeIcon, GearIcon, PanelRightIcon, PlusIcon, SearchIcon } from "../ui/Icons";

interface Action {
  id: string;
  label: string;
  hint?: string;
  icon: JSX.Element;
  run: () => void;
}

/** Global ⌘K / Ctrl+K command palette: quick actions + conversation jump. */
export function CommandPalette() {
  const { t } = useTranslation();
  const open = useSettings((state) => state.paletteOpen);
  const setOpen = useSettings((state) => state.setPaletteOpen);
  const conversations = useChat((state) => state.conversations);
  const openConversation = useChat((state) => state.open);
  const activeId = useChat((state) => state.activeId);
  const newConversation = useChat((state) => state.newConversation);
  const lastModelId = useSettings((state) => state.lastModelId);
  const mode = useSettings((state) => state.mode);
  const setMode = useSettings((state) => state.setMode);
  const updateMode = useChat((state) => state.updateMode);
  const toggleRightPanel = useSettings((state) => state.toggleRightPanel);
  const setSettingsOpen = useSettings((state) => state.setSettingsOpen);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Global shortcut; component stays mounted so the listener is stable.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(!useSettings.getState().paletteOpen);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setOpen]);

  useEffect(() => {
    if (open) {
      setQuery("");
      // Wait a frame so the input is mounted before focusing.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const needle = query.trim().toLowerCase();
  const actions = useMemo<Action[]>(() => {
    const list: Action[] = [
      {
        id: "new",
        label: t("palette.newChat"),
        icon: <PlusIcon className="h-4 w-4" />,
        run: () => {
          void newConversation(lastModelId);
          setOpen(false);
        },
      },
      {
        id: "mode",
        label: mode === "chat" ? t("palette.switchCoding") : t("palette.switchChat"),
        icon: mode === "chat" ? <CodeIcon className="h-4 w-4" /> : <ChatIcon className="h-4 w-4" />,
        run: () => {
          const next = mode === "chat" ? "coding" : "chat";
          setMode(next);
          const conversationId = useChat.getState().activeId;
          if (conversationId != null) void updateMode(next);
          setOpen(false);
        },
      },
      {
        id: "panel",
        label: t("palette.togglePanel"),
        icon: <PanelRightIcon className="h-4 w-4" />,
        run: () => {
          toggleRightPanel();
          setOpen(false);
        },
      },
      {
        id: "settings",
        label: t("palette.settings"),
        icon: <GearIcon className="h-4 w-4" />,
        run: () => {
          setSettingsOpen(true);
          setOpen(false);
        },
      },
    ];
    if (needle.length === 0) return list;
    return list.filter((action) => action.label.toLowerCase().includes(needle));
  }, [t, needle, mode, lastModelId, newConversation, setOpen, setMode, updateMode, toggleRightPanel, setSettingsOpen]);

  const conversationHits = useMemo(() => {
    if (needle.length === 0) return [];
    return conversations.filter((conversation) =>
      (conversation.title ?? "").toLowerCase().includes(needle),
    );
  }, [conversations, needle]);

  if (!open) return null;

  const runAction = (index: number) => {
    const item = [...actions, ...conversationHits.map((conversation) => ({
      id: conversation.id,
      label: conversation.title ?? t("sidebar.untitled"),
      icon: <ChatIcon className="h-4 w-4" />,
      run: () => {
        void openConversation(conversation.id);
        setOpen(false);
      },
    }))][index];
    item?.run();
  };

  const totalItems = actions.length + conversationHits.length;

  return (
    <div
      className="fixed inset-0 z-[120] flex items-start justify-center bg-black/35 px-4 pt-[15vh] backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setOpen(false);
      }}
    >
      <div className="w-[min(560px,94vw)] overflow-hidden rounded-2xl border border-border bg-surface shadow-[var(--shadow-pop)]">
        <div className="relative border-b border-border">
          <SearchIcon className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-txt-2" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") runAction(0);
              if (event.key === "Escape") setOpen(false);
            }}
            placeholder={t("palette.placeholder")}
            className="h-12 w-full bg-transparent pl-11 pr-10 text-[14px] text-txt-0 outline-none placeholder:text-txt-2"
          />
          <kbd className="absolute right-3 top-1/2 -translate-y-1/2 rounded border border-border bg-bg-2 px-1.5 py-0.5 text-[10px] text-txt-2">
            esc
          </kbd>
        </div>
        <div className="max-h-80 overflow-y-auto p-1.5">
          {totalItems === 0 && (
            <div className="px-3 py-4 text-center text-[13px] text-txt-2">{t("palette.noResults")}</div>
          )}
          {[...actions, ...conversationHits.map((conversation) => ({
            id: conversation.id,
            label: conversation.title ?? t("sidebar.untitled"),
            icon: <ChatIcon className="h-4 w-4" />,
            run: () => {
              void openConversation(conversation.id);
              setOpen(false);
            },
          }))].map((item, index) => (
            <button
              key={item.id}
              type="button"
              onClick={() => runAction(index)}
              className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-[13.5px] transition hover:bg-bg-2 ${
                item.id === activeId ? "text-txt-0" : "text-txt-1"
              }`}
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-bg-2 text-txt-2">
                {item.icon}
              </span>
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {item.id === activeId && <span className="text-[10.5px] text-accent">●</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
