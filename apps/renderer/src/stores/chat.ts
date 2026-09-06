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

export type ChatMode = "single" | "debate" | "agent";
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
}

export interface PendingApproval {
  approvalId: string;
  tool: string;
  argsJson: string;
}

export interface StreamingMessage {
  id: string;
  mode: ChatMode;
  content: string;
  reasoning: string;
  status: "streaming" | "done" | "error" | "cancelled";
  usage: { tokens_in: number; tokens_out: number; estimated: boolean } | null;
  errorDetail: string | null;
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
  terminal: Record<string, TerminalState | undefined>;
  pendingApproval: PendingApproval | null;
  sending: boolean;
  loaded: boolean;

  refresh: () => Promise<void>;
  newConversation: (modelId: string | null, groupId?: string | null) => Promise<Conversation>;
  open: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  rename: (id: string, title: string) => Promise<void>;
  setPinned: (id: string, pinned: boolean) => Promise<void>;
  setActiveModel: (modelId: string) => Promise<void>;
  setActiveGroup: (groupId: string) => Promise<void>;
  updateMode: (mode: "chat" | "coding") => Promise<void>;
  setAutoApprove: (enabled: boolean) => Promise<void>;
  send: (
    text: string,
    attachments?: Array<{ name: string; text?: string; mime_type?: string; data_base64?: string }>,
  ) => Promise<void>;
  cancel: () => void;
  runCommand: (command: string) => void;
  startTerminal: () => void;
  killTerminal: () => void;
  resolveApproval: (approved: boolean) => void;
  wireEvents: () => () => void;
}

const emptyStreaming = (id: string, mode: ChatMode): StreamingMessage => ({
  id,
  mode,
  content: "",
  reasoning: "",
  status: "streaming",
  usage: null,
  errorDetail: null,
  debate: [],
  agentSteps: [],
});

export const useChat = create<ChatState>((set, get) => ({
  conversations: [],
  activeId: null,
  messages: {},
  streaming: {},
  terminal: {},
  pendingApproval: null,
  sending: false,
  loaded: false,

  refresh: async () => {
    const conversations = await listConversations();
    set({ conversations, loaded: true });
  },

  newConversation: async (modelId, groupId) => {
    const { useSettings } = await import("./settings");
    const mode = useSettings.getState().mode;
    const conversation = await createConversation(
      groupId != null
        ? { mode, selection_type: "group", group_id: groupId }
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
            tokens_in: null,
            tokens_out: null,
            tokens_estimated: null,
            attachments_json:
              attachments != null && attachments.length > 0
                ? JSON.stringify(attachments)
                : null,
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

    const offs = [
      client.on("message_start", (payload) => {
        const event = payload as {
          conversation_id: string;
          message_id: string;
          mode?: ChatMode;
        };
        set((state) => ({
          streaming: {
            ...state.streaming,
            [event.conversation_id]: emptyStreaming(
              event.message_id,
              event.mode ?? "single",
            ),
          },
          sending: true,
        }));
      }),

      client.on("token", (payload) => {
        const event = payload as { conversation_id: string; delta: string };
        patchStreaming(event.conversation_id, (current) => ({
          ...current,
          content: current.content + event.delta,
        }));
      }),

      client.on("reasoning_token", (payload) => {
        const event = payload as { conversation_id: string; delta: string };
        patchStreaming(event.conversation_id, (current) => ({
          ...current,
          reasoning: current.reasoning + event.delta,
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
        };
        set({
          pendingApproval: {
            approvalId: event.approval_id,
            tool: event.tool,
            argsJson: event.args_json,
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

      client.on("usage", (payload) => {
        const event = payload as {
          conversation_id: string;
          tokens_in: number;
          tokens_out: number;
          estimated: boolean;
        };
        patchStreaming(event.conversation_id, (current) => ({
          ...current,
          usage: {
            tokens_in: event.tokens_in,
            tokens_out: event.tokens_out,
            estimated: event.estimated,
          },
        }));
      }),

      client.on("error", (payload) => {
        const event = payload as { conversation_id?: string; detail: string };
        if (event.conversation_id == null) return;
        patchStreaming(event.conversation_id as string, (current) => ({
          ...current,
          status: "error",
          errorDetail: event.detail,
        }));
      }),

      client.on("message_done", (payload) => {
        const event = payload as { conversation_id: string; status: string };
        // The server is the source of truth — reload history + conversation list.
        void (async () => {
          try {
            const [detail] = await Promise.all([
              getConversation(event.conversation_id),
              get().refresh(),
            ]);
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
