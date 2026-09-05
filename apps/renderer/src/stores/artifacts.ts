import { create } from "zustand";

/** An artifact = one fenced code block extracted from an assistant message. */
export interface Artifact {
  id: string;
  messageId: string;
  title: string;
  language: string;
  code: string;
}

interface ArtifactsState {
  artifacts: Artifact[];
  activeId: string | null;
  register: (messageId: string, blocks: Array<{ language: string; code: string }>) => void;
  /** Adds a single ad-hoc artifact (panel button); returns its id. */
  push: (language: string, code: string) => string;
  clearConversation: () => void;
  open: (id: string) => void;
}

/** Extracts fenced code blocks (with optional language tag) from markdown. */
export function extractCodeBlocks(markdown: string): Array<{ language: string; code: string }> {
  const blocks: Array<{ language: string; code: string }> = [];
  const fence = /```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(markdown)) != null) {
    const code = (match[2] ?? "").trimEnd();
    if (code.length > 0) {
      blocks.push({ language: match[1] || "text", code });
    }
  }
  return blocks;
}

export const useArtifacts = create<ArtifactsState>((set, get) => ({
  artifacts: [],
  activeId: null,

  register: (messageId, blocks) => {
    const existing = get().artifacts.filter((artifact) => artifact.messageId !== messageId);
    const added = blocks.map((block, index) => ({
      id: `${messageId}:${index}`,
      messageId,
      title: (block.code.split("\n")[0] || "code").slice(0, 42),
      language: block.language,
      code: block.code,
    }));
    set({ artifacts: [...existing, ...added] });
  },

  push: (language, code) => {
    const id = `adhoc:${Date.now()}`;
    set((state) => ({
      artifacts: [
        ...state.artifacts,
        {
          id,
          messageId: id,
          title: code.split("\n")[0]?.slice(0, 42) ?? "code",
          language,
          code,
        },
      ],
    }));
    return id;
  },

  clearConversation: () => set({ artifacts: [], activeId: null }),

  open: (id) => set({ activeId: id }),
}));
