import { useEffect } from "react";

import { useChat } from "../stores/chat";
import { useModels } from "../stores/models";
import { useSettings } from "../stores/settings";

/**
 * Global shortcuts beyond ⌘K:
 * - ⌘/Ctrl + N        new chat
 * - ⌘/Ctrl + Shift + M   cycle active conversation's model (single mode)
 * - ⌘/Ctrl + Shift + G   start a model race with the active group
 * - ⌘/Ctrl + Alt + ↑/↓   previous / next conversation
 * - ⌘/Ctrl + Shift + E   toggle artifacts panel
 * Typing in inputs is ignored (except when the modifier is present).
 */
export function useShortcuts() {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target != null &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);
      const mod = event.ctrlKey || event.metaKey;
      if (typing && !mod) return;
      const key = event.key.toLowerCase();

      if (mod && !event.shiftKey && !event.altKey && key === "n") {
        event.preventDefault();
        void useChat
          .getState()
          .newConversation(useSettings.getState().lastModelId);
        return;
      }

      if (mod && event.shiftKey && !event.altKey && key === "m") {
        event.preventDefault();
        cycleModel();
        return;
      }

      if (mod && event.shiftKey && !event.altKey && key === "g") {
        event.preventDefault();
        const state = useChat.getState();
        const conversation = state.conversations.find(
          (entry) => entry.id === state.activeId,
        );
        if (conversation?.selection_type === "group" && conversation.group_id != null) {
          void state.setActiveRace(conversation.group_id);
        }
        return;
      }

      if (mod && event.altKey && (key === "arrowup" || key === "arrowdown")) {
        event.preventDefault();
        const state = useChat.getState();
        const list = state.conversations
          .filter((entry) => entry.mode === useSettings.getState().mode)
          .map((entry) => entry.id);
        if (list.length === 0) return;
        const index = list.indexOf(state.activeId ?? "");
        const nextId =
          event.key === "ArrowUp"
            ? list[(index - 1 + list.length) % list.length]
            : list[(index + 1) % list.length];
        if (nextId != null && nextId !== state.activeId) void state.open(nextId);
        return;
      }

      if (mod && event.shiftKey && !event.altKey && key === "e") {
        event.preventDefault();
        useSettings.getState().toggleRightPanel();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

/** Cycles the active conversation through enabled models (single mode). */
function cycleModel() {
  const chat = useChat.getState();
  const conversation = chat.conversations.find((entry) => entry.id === chat.activeId);
  if (conversation == null || conversation.selection_type === "group") return;
  const enabled = useModels.getState().models.filter((model) => model.enabled);
  if (enabled.length === 0) return;
  const currentIndex = enabled.findIndex((model) => model.id === conversation.model_id);
  const next = enabled[(currentIndex + 1) % enabled.length];
  if (next != null) void chat.setActiveModel(next.id);
}
