import { create } from "zustand";

import {
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  setMessageFeedback,
  updateConversation,
  type Conversation,
  type Message,
} from "../lib/api";
import { wsClient } from "../lib/connection";

export type ChatMode = "single" | "debate" | "agent" | "race";
export type DebatePhase = "initial" | "critique" | "synthesis";

export interface DebateTurnState {
  modelId: string;
  anonLabel: string;
  content: string;
  reasoning: string;
  tokensIn: number | null;
  tokensOut: number | null;
  done: boolean;
}

export interface DebateRoundState {
  round: number;
  phase: DebatePhase;
  turns: DebateTurnState[];
  consensus: { reached: boolean; reason: string } | null;
}

export interface AgentStepState {
  step: number;
  tool: string;
  args: string;
  output: string;
  ok: boolean;
  running: boolean;
  /** Conversation/message ids for the undo endpoint (persisted steps). */
  conversationId?: string;
  messageId?: string;
  /** JSON undo payload presence means the step can be restored. */
  undoable?: boolean;
  /** True while an undo request is in flight. */
  undoing?: boolean;
}

export interface PendingApproval {
  approvalId: string;
  tool: string;
  argsJson: string;
  /** Unified diff of the pending file change (fs_write/fs_delete). */
  diff: string | null;
}

export interface StreamingMessage {
  id: string;
  /** The conversation this stream belongs to (race lanes share one). */
  conversationId: string;
  modelId: string | null;
  mode: ChatMode;
  content: string;
  reasoning: string;
  status: "streaming" | "done" | "error" | "cancelled";
  resolvedModel: string | null;
  usage: { tokens_in: number; tokens_out: number; estimated: boolean } | null;
  errorDetail: string | null;
  /** Set on model-race lanes; used to render side-by-side columns. */
  raceId: string | null;
  /** Provider fallback notice (shown under the answer). */
  fallback: { from: string; to: string; detail: string | null } | null;
  debate: DebateRoundState[];
  agentSteps: AgentStepState[];
}

export interface TerminalState {
  lines: string[];
  running: boolean;
  started: boolean;
  lastCommand: string | null;
}

interface ChatState {
  conversations: Conversation[];
  activeId: string | null;
  messages: Record<string, Message[]>;
  streaming: Record<string, StreamingMessage | undefined>;
  /** Model-race lanes keyed by message id (N streams per conversation). */
  raceStreams: Record<string, StreamingMessage | undefined>;
  /** In-flight stream count per conversation (drives `sending`). */
  pendingRuns: Record<string, number>;
  terminal: Record<string, TerminalState | undefined>;
  pendingApproval: PendingApproval | null;
  sending: boolean;
  loaded: boolean;
  /** Text filter for messages inside the active conversation ('' = off). */
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  /** Thumbs feedback for a persisted assistant message (1/-1/0 to clear). */
  rateMessage: (messageId: string, rating: number) => Promise<void>;

  refresh: () => Promise<void>;
  newConversation: (
    modelId: string | null,
    groupId?: string | null,
    race?: boolean,
  ) => Promise<Conversation>;
  open: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  rename: (id: string, title: string) => Promise<void>;
  setPinned: (id: string, pinned: boolean) => Promise<void>;
  setActiveModel: (modelId: string) => Promise<void>;
  setActiveGroup: (groupId: string) => Promise<void>;
  /** Switches the active conversation to model-race mode (same group). */
  setActiveRace: (groupId: string) => Promise<void>;
  updateMode: (mode: "chat" | "coding") => Promise<void>;
  setAutoApprove: (enabled: boolean) => Promise<void>;
  setPlanMode: (enabled: boolean) => Promise<void>;
  setApprovalProfile: (profile: "all" | "mutating" | "git" | "never") => Promise<void>;
  setFallbackModel: (modelId: string | null) => Promise<void>;
  send: (
    text: string,
    attachments?: Array<{ name: string; text?: string; mime_type?: string; data_base64?: string }>,
  ) => Promise<void>;
  editMessage: (
    messageId: string,
    content: string,
    quote: boolean,
  ) => Promise<void>;
  regenerate: (messageId: string, modelId?: string | null) => Promise<void>;
  cancel: () => void;
  runCommand: (command: string) => void;
  startTerminal: () => void;
  killTerminal: () => void;
  resolveApproval: (approved: boolean) => void;
  wireEvents: () => () => void;
}

const emptyStreaming = (
  id: string,
  conversationId: string,
  modelId: string | null,
  mode: ChatMode,
  raceId: string | null,
): StreamingMessage => ({
  id,
  conversationId,
  modelId,
  mode,
  content: "",
  reasoning: "",
  status: "streaming",
  resolvedModel: null,
  usage: null,
  errorDetail: null,
  raceId,
  fallback: null,
  debate: [],
  agentSteps: [],
});

export const useChat = create<ChatState>((set, get) => ({
  conversations: [],
  activeId: null,
  messages: {},
  streaming: {},
  raceStreams: {},
  pendingRuns: {},
  terminal: {},
  pendingApproval: null,
  sending: false,
  loaded: false,
  searchQuery: "",

  refresh: async () => {
    const conversations = await listConversations();
    set({ conversations, loaded: true });
  },

  newConversation: async (modelId, groupId, race = false) => {
    const { activeId, messages } = get();
    // Point 9: an empty conversation is already a "new chat" — don't create a
    // second one when the user is sitting in a conversation with no messages.
    // (Undefined = not loaded yet; only [] counts as empty.)
    if (activeId != null && (messages[activeId]?.length ?? -1) === 0) {
      const existing = get().conversations.find((c) => c.id === activeId);
      if (existing != null) {
        // Keep the user's model selection on the existing empty chat.
        if (groupId == null && modelId != null && existing.model_id !== modelId) {
          await updateConversation(existing.id, { model_id: modelId, selection_type: "single" });
          await get().refresh();
        }
        return existing;
      }
    }
    const { useSettings } = await import("./settings");
    const mode = useSettings.getState().mode;
    const conversation = await createConversation(
      groupId != null
        ? { mode, selection_type: race ? "race" : "group", group_id: groupId }
        : { mode, model_id: modelId },
    );
    await get().refresh();
    set((state) => ({
      activeId: conversation.id,
      messages: { ...state.messages, [conversation.id]: [] },
    }));
    return conversation;
  },

  open: async (id) => {
    set({ activeId: id, searchQuery: "" });
    const detail = await getConversation(id);
    set((state) => ({ messages: { ...state.messages, [id]: detail.messages } }));
  },

  setSearchQuery: (searchQuery) => set({ searchQuery }),

  rateMessage: async (messageId, rating) => {
    const { activeId } = get();
    if (activeId == null) return;
    // Optimistic update; the server is the source of truth after refresh.
    set((state) => ({
      messages: {
        ...state.messages,
        [activeId]: (state.messages[activeId] ?? []).map((message) =>
          message.id === messageId ? { ...message, feedback: rating } : message,
        ),
      },
    }));
    try {
      await setMessageFeedback(messageId, rating);
    } catch {
      // Roll back the optimistic change on failure.
      set((state) => ({
        messages: {
          ...state.messages,
          [activeId]: (state.messages[activeId] ?? []).map((message) =>
            message.id === messageId
              ? { ...message, feedback: message.feedback === rating ? null : message.feedback }
              : message,
          ),
        },
      }));
    }
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

  rename: async (id, title) => {
    await updateConversation(id, { title });
    set((state) => ({
      conversations: state.conversations.map((conversation) =>
        conversation.id === id ? { ...conversation, title } : conversation,
      ),
    }));
  },

  setPinned: async (id, pinned) => {
    await updateConversation(id, { pinned });
    set((state) => ({
      conversations: state.conversations.map((conversation) =>
        conversation.id === id ? { ...conversation, pinned } : conversation,
      ),
    }));
  },

  setActiveModel: async (modelId) => {
    const { activeId } = get();
    if (activeId == null) return;
    await updateConversation(activeId, { model_id: modelId, selection_type: "single" });
    const updated = get().conversations.map((conversation) =>
      conversation.id === activeId
        ? { ...conversation, model_id: modelId, selection_type: "single" as const, group_id: null }
        : conversation,
    );
    set({ conversations: updated });
  },

  setActiveGroup: async (groupId) => {
    const { activeId } = get();
    if (activeId == null) return;
    await updateConversation(activeId, { selection_type: "group", group_id: groupId });
    const updated = get().conversations.map((conversation) =>
      conversation.id === activeId
        ? { ...conversation, selection_type: "group" as const, group_id: groupId, model_id: null }
        : conversation,
    );
    set({ conversations: updated });
  },

  setActiveRace: async (groupId) => {
    const { activeId } = get();
    if (activeId == null) return;
    await updateConversation(activeId, { selection_type: "race", group_id: groupId });
    const updated = get().conversations.map((conversation) =>
      conversation.id === activeId
        ? { ...conversation, selection_type: "race" as const, group_id: groupId, model_id: null }
        : conversation,
    );
    set({ conversations: updated });
  },

  updateMode: async (mode) => {
    const { activeId } = get();
    if (activeId == null) return;
    await updateConversation(activeId, { mode });
    set((state) => ({
      conversations: state.conversations.map((conversation) =>
        conversation.id === activeId ? { ...conversation, mode } : conversation,
      ),
    }));
  },

  setAutoApprove: async (enabled) => {
    const { activeId } = get();
    if (activeId == null) return;
    await updateConversation(activeId, { agent_auto_approve: enabled });
    set((state) => ({
      conversations: state.conversations.map((conversation) =>
        conversation.id === activeId ? { ...conversation, agent_auto_approve: enabled } : conversation,
      ),
    }));
  },
  setPlanMode: async (enabled) => {
    const { activeId } = get();
    if (activeId == null) return;
    await updateConversation(activeId, { agent_plan_mode: enabled });
    set((state) => ({
      conversations: state.conversations.map((conversation) =>
        conversation.id === activeId ? { ...conversation, agent_plan_mode: enabled } : conversation,
      ),
    }));
  },
  setApprovalProfile: async (profile) => {
    const { activeId } = get();
    if (activeId == null) return;
    await updateConversation(activeId, { agent_approval_profile: profile });
    set((state) => ({
      conversations: state.conversations.map((conversation) =>
        conversation.id === activeId ? { ...conversation, agent_approval_profile: profile } : conversation,
      ),
    }));
  },
  setFallbackModel: async (modelId) => {
    const { activeId } = get();
    if (activeId == null) return;
    await updateConversation(activeId, { fallback_model_id: modelId });
    set((state) => ({
      conversations: state.conversations.map((conversation) =>
        conversation.id === activeId ? { ...conversation, fallback_model_id: modelId } : conversation,
      ),
    }));
  },

  send: async (text, attachments) => {
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
            resolved_model: null,
            has_debate: null,
            tokens_in: null,
            tokens_out: null,
            tokens_estimated: null,
            fallback_from_model_id: null,
            attachments_json:
              attachments != null && attachments.length > 0
                ? JSON.stringify(attachments)
                : null,
            feedback: null,
            race_id: null,
            created_at: new Date().toISOString(),
          },
        ],
      },
    }));

    const { useSettings } = await import("./settings");
    wsClient().send("send_message", {
      conversation_id: conversationId,
      content: trimmed,
      attachments: attachments ?? [],
      web: useSettings.getState().webSearch,
    });
  },

  editMessage: async (messageId, content, quote) => {
    const trimmed = content.trim();
    if (trimmed.length === 0) return;
    const { activeId } = get();
    if (activeId == null) return;
    const conversationId = activeId;
    set((state) => {
      const list = state.messages[conversationId] ?? [];
      const index = list.findIndex((message) => message.id === messageId);
      if (index === -1) return {};
      const edited = list.map((message, i) =>
        i === index ? { ...message, content: trimmed } : message,
      );
      return {
        messages: { ...state.messages, [conversationId]: edited.slice(0, index + 1) },
        streaming: { ...state.streaming, [conversationId]: undefined },
        raceStreams: clearRaceStreams(state.raceStreams, conversationId),
        sending: true,
      };
    });
    const { useSettings } = await import("./settings");
    wsClient().send("edit_message", {
      conversation_id: conversationId,
      message_id: messageId,
      content: trimmed,
      quote,
      web: useSettings.getState().webSearch,
    });
  },

  regenerate: async (messageId, modelId = null) => {
    const { activeId } = get();
    if (activeId == null) return;
    const conversationId = activeId;
    set((state) => {
      const list = state.messages[conversationId] ?? [];
      const index = list.findIndex((message) => message.id === messageId);
      if (index === -1) return {};
      return {
        messages: { ...state.messages, [conversationId]: list.slice(0, index) },
        streaming: { ...state.streaming, [conversationId]: undefined },
        raceStreams: clearRaceStreams(state.raceStreams, conversationId),
        sending: true,
      };
    });
    wsClient().send("regenerate", {
      conversation_id: conversationId,
      message_id: messageId,
      model_id: modelId,
    });
  },

  cancel: () => {
    const { activeId } = get();
    if (activeId == null) return;
    wsClient().send("cancel", { conversation_id: activeId });
  },

  runCommand: (command) => {
    const { activeId } = get();
    if (activeId == null) return;
    const started = get().terminal[activeId]?.started ?? false;
    set((state) => ({
      terminal: {
        ...state.terminal,
        [activeId]: {
          lines: [...(state.terminal[activeId]?.lines ?? []), `$ ${command}`],
          running: true,
          started: true,
          lastCommand: command,
        },
      },
    }));
    // Session terminal: ensure the shell exists, then feed the command line.
    if (!started) wsClient().send("terminal_start", { conversation_id: activeId });
    wsClient().send("terminal_input", { conversation_id: activeId, data: `${command}
` });
  },

  startTerminal: () => {
    const { activeId } = get();
    if (activeId == null) return;
    wsClient().send("terminal_start", { conversation_id: activeId });
  },

  killTerminal: () => {
    const { activeId } = get();
    if (activeId == null) return;
    wsClient().send("terminal_kill", { conversation_id: activeId });
    set((state) => ({
      terminal: {
        ...state.terminal,
        [activeId]: { lines: state.terminal[activeId]?.lines ?? [], running: false, started: false, lastCommand: null },
      },
    }));
  },

  resolveApproval: (approved) => {
    const approval = get().pendingApproval;
    if (approval == null) return;
    set({ pendingApproval: null });
    wsClient().send("agent_approve", {
      approval_id: approval.approvalId,
      approved,
    });
  },

  wireEvents: () => {
    const client = wsClient();

    const patchStreaming = (
      conversationId: string,
      patch: (message: StreamingMessage) => StreamingMessage,
    ) =>
      set((state) => {
        const current = state.streaming[conversationId];
        if (current == null) return {};
        return {
          streaming: { ...state.streaming, [conversationId]: patch(current) },
        };
      });

    /** Patches a race lane (by message id) when present, else the main stream. */
    const patchMessage = (
      messageId: string,
      conversationId: string,
      patch: (message: StreamingMessage) => StreamingMessage,
    ) =>
      set((state) => {
        const race = state.raceStreams[messageId];
        if (race != null) {
          return {
            raceStreams: { ...state.raceStreams, [messageId]: patch(race) },
          };
        }
        const current = state.streaming[conversationId];
        if (current == null) return {};
        return {
          streaming: { ...state.streaming, [conversationId]: patch(current) },
        };
      });

    const offs = [
      client.on("message_start", (payload) => {
        const event = payload as {
          conversation_id: string;
          message_id: string;
          model_id?: string;
          mode?: ChatMode;
          race_id?: string | null;
        };
        const stream = emptyStreaming(
          event.message_id,
          event.conversation_id,
          event.model_id ?? null,
          event.mode ?? "single",
          event.race_id ?? null,
        );
        set((state) => ({
          streaming:
            stream.raceId == null
              ? { ...state.streaming, [event.conversation_id]: stream }
              : state.streaming,
          raceStreams:
            stream.raceId != null
              ? { ...state.raceStreams, [event.message_id]: stream }
              : state.raceStreams,
          pendingRuns: {
            ...state.pendingRuns,
            [event.conversation_id]: (state.pendingRuns[event.conversation_id] ?? 0) + 1,
          },
          sending: true,
        }));
      }),

      client.on("token", (payload) => {
        const event = payload as {
          conversation_id: string;
          message_id: string;
          delta: string;
        };
        patchMessage(event.message_id, event.conversation_id, (current) => ({
          ...current,
          content: current.content + event.delta,
        }));
      }),

      client.on("reasoning_token", (payload) => {
        const event = payload as {
          conversation_id: string;
          message_id: string;
          delta: string;
        };
        patchMessage(event.message_id, event.conversation_id, (current) => ({
          ...current,
          reasoning: current.reasoning + event.delta,
        }));
      }),

      client.on("model_resolved", (payload) => {
        const event = payload as {
          conversation_id: string;
          message_id: string;
          model_id: string;
        };
        patchMessage(event.message_id, event.conversation_id, (current) => ({
          ...current,
          resolvedModel: event.model_id,
        }));
      }),

      /* ---------------------------------------------------------------- debate */

      client.on("debate_round_start", (payload) => {
        const event = payload as { conversation_id: string; round: number; phase: DebatePhase };
        patchStreaming(event.conversation_id, (current) => ({
          ...current,
          mode: "debate",
          debate: [
            ...current.debate,
            { round: event.round, phase: event.phase, turns: [], consensus: null },
          ],
        }));
      }),

      client.on("debate_turn_token", (payload) => {
        const event = payload as {
          conversation_id: string;
          round: number;
          model_id: string;
          anon_label: string;
          delta: string;
        };
        patchStreaming(event.conversation_id, (current) => {
          // Only the leader's synthesis turn is part of the final answer; the
          // argument rounds are rendered by DebateStream alone.
          const roundState = current.debate.find((round) => round.round === event.round);
          const isSynthesis = roundState?.phase === "synthesis";
          return {
            ...current,
            mode: "debate",
            content: isSynthesis ? current.content + event.delta : current.content,
            debate: current.debate.map((state) =>
              state.round !== event.round
                ? state
                : {
                    ...state,
                    turns: upsertTurn(state.turns, event.model_id, event.anon_label, {
                      content: event.delta,
                    }),
                  },
            ),
          };
        });
      }),

      client.on("debate_turn_reasoning_token", (payload) => {
        const event = payload as {
          conversation_id: string;
          round: number;
          model_id: string;
          anon_label: string;
          delta: string;
        };
        patchStreaming(event.conversation_id, (current) => ({
          ...current,
          mode: "debate",
          debate: current.debate.map((roundState) =>
            roundState.round !== event.round
              ? roundState
              : {
                  ...roundState,
                  turns: upsertTurn(roundState.turns, event.model_id, event.anon_label, {
                    reasoning: event.delta,
                  }),
                },
          ),
        }));
      }),

      client.on("debate_turn_done", (payload) => {
        const event = payload as {
          conversation_id: string;
          round: number;
          model_id: string;
          tokens_in: number;
          tokens_out: number;
        };
        patchStreaming(event.conversation_id, (current) => ({
          ...current,
          debate: current.debate.map((roundState) =>
            roundState.round !== event.round
              ? roundState
              : {
                  ...roundState,
                  turns: roundState.turns.map((turn) =>
                    turn.modelId === event.model_id
                      ? {
                          ...turn,
                          tokensIn: event.tokens_in,
                          tokensOut: event.tokens_out,
                          done: true,
                        }
                      : turn,
                  ),
                },
          ),
        }));
      }),

      client.on("debate_consensus", (payload) => {
        const event = payload as {
          conversation_id: string;
          reached: boolean;
          reason: string;
        };
        patchStreaming(event.conversation_id, (current) => {
          const last = current.debate[current.debate.length - 1];
          if (last == null) return current;
          return {
            ...current,
            debate: current.debate.map((roundState, index) =>
              index === current.debate.length - 1
                ? {
                    ...roundState,
                    consensus: { reached: event.reached, reason: event.reason },
                  }
                : roundState,
            ),
          };
        });
      }),

      client.on("debate_done", (payload) => {
        const event = payload as { conversation_id: string };
        patchStreaming(event.conversation_id, (current) => ({ ...current, mode: "debate" }));
      }),

      /* ----------------------------------------------------------------- agent */

      client.on("agent_tool_start", (payload) => {
        const event = payload as {
          conversation_id: string;
          step: number;
          tool: string;
          args_json: string;
        };
        patchStreaming(event.conversation_id, (current) => ({
          ...current,
          mode: "agent",
          agentSteps: [
            ...current.agentSteps.filter((step) => step.step !== event.step),
            {
              step: event.step,
              tool: event.tool,
              args: event.args_json,
              output: "",
              ok: false,
              running: true,
            },
          ],
        }));
      }),

      client.on("agent_tool_result", (payload) => {
        const event = payload as {
          conversation_id: string;
          step: number;
          tool: string;
          ok: boolean;
          output: string;
        };
        patchStreaming(event.conversation_id, (current) => ({
          ...current,
          mode: "agent",
          agentSteps: current.agentSteps.map((step) =>
            step.step === event.step
              ? { ...step, output: event.output, ok: event.ok, running: false }
              : step,
          ),
        }));
      }),

      client.on("agent_approval_request", (payload) => {
        const event = payload as {
          approval_id: string;
          tool: string;
          args_json: string;
          diff?: string | null;
        };
        set({
          pendingApproval: {
            approvalId: event.approval_id,
            tool: event.tool,
            argsJson: event.args_json,
            diff: event.diff ?? null,
          },
        });
      }),

      /* -------------------------------------------------------------- terminal */

      client.on("terminal_output", (payload) => {
        const event = payload as { conversation_id: string; chunk: string };
        set((state) => {
          const current = state.terminal[event.conversation_id] ?? {
            lines: [],
            running: true,
            started: true,
            lastCommand: null,
          };
          return {
            terminal: {
              ...state.terminal,
              [event.conversation_id]: {
                ...current,
                running: true,
                lines: [...current.lines, event.chunk],
              },
            },
          };
        });
      }),

      client.on("terminal_exit", (payload) => {
        const event = payload as { conversation_id: string; code: number | null };
        set((state) => {
          const current = state.terminal[event.conversation_id] ?? {
            lines: [],
            running: true,
            started: true,
            lastCommand: null,
          };
          return {
            terminal: {
              ...state.terminal,
              [event.conversation_id]: {
                ...current,
                running: false,
                lines: [
                  ...current.lines,
                  event.code != null ? `(exit ${event.code})\n` : "\n",
                ].slice(-500),
              },
            },
          };
        });
      }),

      client.on("fallback_used", (payload) => {
        const event = payload as {
          conversation_id: string;
          message_id: string;
          from_model: string;
          to_model: string;
          detail: string | null;
        };
        patchMessage(event.message_id, event.conversation_id, (current) => ({
          ...current,
          fallback: {
            from: event.from_model,
            to: event.to_model,
            detail: event.detail ?? null,
          },
        }));
      }),

      client.on("usage", (payload) => {
        const event = payload as {
          conversation_id: string;
          message_id: string;
          tokens_in: number;
          tokens_out: number;
          estimated: boolean;
        };
        patchMessage(event.message_id, event.conversation_id, (current) => ({
          ...current,
          usage: {
            tokens_in: event.tokens_in,
            tokens_out: event.tokens_out,
            estimated: event.estimated,
          },
        }));
      }),

      client.on("fallback_used", (payload) => {
        const event = payload as {
          conversation_id: string;
          message_id: string;
          from_model: string;
          to_model: string;
          detail: string | null;
        };
        patchMessage(event.message_id, event.conversation_id, (current) => ({
          ...current,
          fallback: {
            from: event.from_model,
            to: event.to_model,
            detail: event.detail ?? null,
          },
        }));
      }),

      client.on("error", (payload) => {
        const event = payload as {
          conversation_id?: string;
          message_id?: string;
          detail: string;
        };
        if (event.conversation_id == null) return;
        const conversationId = event.conversation_id as string;
        // A race lane error belongs to its stream; the lane stays visible.
        if (event.message_id != null && get().raceStreams[event.message_id] != null) {
          const messageId = event.message_id;
          set((state) => ({
            raceStreams: {
              ...state.raceStreams,
              [messageId]: {
                ...state.raceStreams[messageId]!,
                status: "error",
                errorDetail: event.detail,
              },
            },
          }));
          return;
        }
        // Errors before any stream (e.g. edit/regenerate validation) must also
        // release the composer lock and resync history.
        if (get().streaming[conversationId] == null) {
          set((state) => ({
            sending: false,
            pendingRuns: { ...state.pendingRuns, [conversationId]: 0 },
            streaming: { ...state.streaming, [conversationId]: undefined },
          }));
          void getConversation(conversationId)
            .then((detail) =>
              set((state) => ({
                messages: { ...state.messages, [conversationId]: detail.messages },
              })),
            )
            .catch(() => undefined);
          return;
        }
        patchStreaming(conversationId, (current) => ({
          ...current,
          status: "error",
          errorDetail: event.detail,
        }));
      }),

      client.on("message_done", (payload) => {
        const event = payload as {
          conversation_id: string;
          message_id: string;
          status: string;
        };
        // The server is the source of truth — reload history + conversation list.
        void (async () => {
          try {
            const [detail] = await Promise.all([
              getConversation(event.conversation_id),
              get().refresh(),
            ]);
            set((state) => {
              const nextPending = Math.max(0, (state.pendingRuns[event.conversation_id] ?? 1) - 1);
              const raceStreams = { ...state.raceStreams };
              delete raceStreams[event.message_id];
              return {
                messages: { ...state.messages, [event.conversation_id]: detail.messages },
                streaming: { ...state.streaming, [event.conversation_id]: undefined },
                raceStreams,
                pendingRuns: { ...state.pendingRuns, [event.conversation_id]: nextPending },
                sending: nextPending > 0,
              };
            });
          } catch {
            set((state) => {
              const nextPending = Math.max(0, (state.pendingRuns[event.conversation_id] ?? 1) - 1);
              const raceStreams = { ...state.raceStreams };
              delete raceStreams[event.message_id];
              return {
                streaming: { ...state.streaming, [event.conversation_id]: undefined },
                raceStreams,
                pendingRuns: { ...state.pendingRuns, [event.conversation_id]: nextPending },
                sending: nextPending > 0,
              };
            });
          }
        })();
      }),
    ];

    return () => offs.forEach((off) => off());
  },
}));

function clearRaceStreams(
  raceStreams: Record<string, StreamingMessage | undefined>,
  conversationId: string,
): Record<string, StreamingMessage | undefined> {
  const next = { ...raceStreams };
  for (const [id, stream] of Object.entries(next)) {
    if (stream?.conversationId === conversationId) delete next[id];
  }
  return next;
}

function upsertTurn(
  turns: DebateTurnState[],
  modelId: string,
  anonLabel: string,
  delta: { content?: string; reasoning?: string },
): DebateTurnState[] {
  const existing = turns.find((turn) => turn.modelId === modelId);
  if (existing == null) {
    return [
      ...turns,
      {
        modelId,
        anonLabel,
        content: delta.content ?? "",
        reasoning: delta.reasoning ?? "",
        tokensIn: null,
        tokensOut: null,
        done: false,
      },
    ];
  }
  return turns.map((turn) =>
    turn.modelId === modelId
      ? {
          ...turn,
          anonLabel,
          content: turn.content + (delta.content ?? ""),
          reasoning: turn.reasoning + (delta.reasoning ?? ""),
        }
      : turn,
  );
}
