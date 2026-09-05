import { create } from "zustand";

import {
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  updateConversation,
  type Conversation,
  type Message,
} from "../lib/api";
import { wsClient } from "../lib/connection";

export interface StreamingMessage {
  id: string;
  content: string;
  reasoning: string;
  status: "streaming" | "done" | "error" | "cancelled";
  usage: { tokens_in: number; tokens_out: number; estimated: boolean } | null;
  errorDetail: string | null;
}

interface ChatState {
  conversations: Conversation[];
  activeId: string | null;
  messages: Record<string, Message[]>;
  streaming: Record<string, StreamingMessage | undefined>;
  sending: boolean;
  loaded: boolean;

  refresh: () => Promise<void>;
  newConversation: (modelId: string | null) => Promise<Conversation>;
  open: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  setActiveModel: (modelId: string) => Promise<void>;
  send: (text: string) => Promise<void>;
  cancel: () => void;
  /** Wire WS chat events into the store; returns an unsubscribe fn. */
  wireEvents: () => () => void;
}

export const useChat = create<ChatState>((set, get) => ({
  conversations: [],
  activeId: null,
  messages: {},
  streaming: {},
  sending: false,
  loaded: false,

  refresh: async () => {
    const conversations = await listConversations();
    set({ conversations, loaded: true });
  },

  newConversation: async (modelId) => {
    const mode = "chat";
    const conversation = await createConversation({ mode, model_id: modelId });
    await get().refresh();
    set((state) => ({
      activeId: conversation.id,
      messages: { ...state.messages, [conversation.id]: [] },
    }));
    return conversation;
  },

  open: async (id) => {
    set({ activeId: id });
    const detail = await getConversation(id);
    set((state) => ({ messages: { ...state.messages, [id]: detail.messages } }));
  },

  remove: async (id) => {
    await deleteConversation(id);
    set((state) => {
      const messages = { ...state.messages };
      delete messages[id];
      return {
        conversations: state.conversations.filter((conversation) => conversation.id !== id),
        activeId: state.activeId === id ? null : state.activeId,
        messages,
      };
    });
  },

  setActiveModel: async (modelId) => {
    const { activeId } = get();
    if (activeId == null) return;
    await updateConversation(activeId, { model_id: modelId });
    const updated = get().conversations.map((conversation) =>
      conversation.id === activeId ? { ...conversation, model_id: modelId } : conversation,
    );
    set({ conversations: updated });
  },

  send: async (text) => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    let conversationId = get().activeId;
    if (conversationId == null) {
      const { useSettings } = await import("./settings");
      const conversation = await get().newConversation(useSettings.getState().lastModelId);
      conversationId = conversation.id;
    }

    set((state) => ({
      sending: true,
      messages: {
        ...state.messages,
        [conversationId as string]: [
          ...(state.messages[conversationId as string] ?? []),
          {
            id: `local-${Date.now()}`,
            conversation_id: conversationId as string,
            role: "user" as const,
            content: trimmed,
            reasoning: null,
            model_id: null,
            tokens_in: null,
            tokens_out: null,
            tokens_estimated: null,
            attachments_json: null,
            created_at: new Date().toISOString(),
          },
        ],
      },
    }));

    wsClient().send("send_message", {
      conversation_id: conversationId,
      content: trimmed,
    });
  },

  cancel: () => {
    const { activeId } = get();
    if (activeId == null) return;
    wsClient().send("cancel", { conversation_id: activeId });
  },

  wireEvents: () => {
    const client = wsClient();

    const offs = [
      client.on("message_start", (payload) => {
        const event = payload as {
          conversation_id: string;
          message_id: string;
        };
        set((state) => ({
          streaming: {
            ...state.streaming,
            [event.conversation_id]: {
              id: event.message_id,
              content: "",
              reasoning: "",
              status: "streaming",
              usage: null,
              errorDetail: null,
            },
          },
          sending: true,
        }));
      }),

      client.on("token", (payload) => {
        const event = payload as { conversation_id: string; delta: string };
        set((state) => {
          const current = state.streaming[event.conversation_id];
          if (current == null) return {};
          return {
            streaming: {
              ...state.streaming,
              [event.conversation_id]: { ...current, content: current.content + event.delta },
            },
          };
        });
      }),

      client.on("reasoning_token", (payload) => {
        const event = payload as { conversation_id: string; delta: string };
        set((state) => {
          const current = state.streaming[event.conversation_id];
          if (current == null) return {};
          return {
            streaming: {
              ...state.streaming,
              [event.conversation_id]: { ...current, reasoning: current.reasoning + event.delta },
            },
          };
        });
      }),

      client.on("usage", (payload) => {
        const event = payload as {
          conversation_id: string;
          tokens_in: number;
          tokens_out: number;
          estimated: boolean;
        };
        set((state) => {
          const current = state.streaming[event.conversation_id];
          if (current == null) return {};
          return {
            streaming: {
              ...state.streaming,
              [event.conversation_id]: { ...current, usage: {
                tokens_in: event.tokens_in,
                tokens_out: event.tokens_out,
                estimated: event.estimated,
              } },
            },
          };
        });
      }),

      client.on("error", (payload) => {
        const event = payload as { conversation_id?: string; detail: string };
        if (event.conversation_id == null) return;
        set((state) => {
          const current = state.streaming[event.conversation_id as string];
          if (current == null) return {};
          return {
            streaming: {
              ...state.streaming,
              [event.conversation_id as string]: {
                ...current,
                status: "error",
                errorDetail: event.detail,
              },
            },
          };
        });
      }),

      client.on("message_done", (payload) => {
        const event = payload as { conversation_id: string; status: string };
        // The server is the source of truth — reload history + conversation list.
        void (async () => {
          try {
            const [detail] = await Promise.all([getConversation(event.conversation_id), get().refresh()]);
            set((state) => ({
              messages: { ...state.messages, [event.conversation_id]: detail.messages },
              streaming: { ...state.streaming, [event.conversation_id]: undefined },
              sending: false,
            }));
          } catch {
            set((state) => ({
              streaming: { ...state.streaming, [event.conversation_id]: undefined },
              sending: false,
            }));
          }
        })();
      }),
    ];

    return () => offs.forEach((off) => off());
  },
}));
