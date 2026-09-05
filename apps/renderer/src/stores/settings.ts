import { create } from "zustand";
import { persist } from "zustand/middleware";

import i18n, { DEFAULT_LANGUAGE, type AppLanguage } from "../i18n";

export type Mode = "chat" | "coding";

interface SettingsState {
  language: AppLanguage;
  mode: Mode;
  rightPanelOpen: boolean;
  settingsOpen: boolean;
  sidebarCollapsed: boolean;
  /** Model used for the next new conversation (single-model selection). */
  lastModelId: string | null;
  setLanguage: (language: AppLanguage) => void;
  setMode: (mode: Mode) => void;
  toggleRightPanel: () => void;
  setSettingsOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  setLastModelId: (modelId: string | null) => void;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      language: (i18n.language as AppLanguage) ?? DEFAULT_LANGUAGE,
      mode: "chat",
      rightPanelOpen: false,
      settingsOpen: false,
      sidebarCollapsed: false,
      lastModelId: null,
      setLanguage: (language) => {
        void i18n.changeLanguage(language);
        set({ language });
      },
      setMode: (mode) => set({ mode }),
      toggleRightPanel: () => set((state) => ({ rightPanelOpen: !state.rightPanelOpen })),
      setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
      toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      setLastModelId: (lastModelId) => set({ lastModelId }),
    }),
    {
      name: "polylab-settings",
      partialize: (state) => ({
        language: state.language,
        mode: state.mode,
        lastModelId: state.lastModelId,
        sidebarCollapsed: state.sidebarCollapsed,
      }),
    },
  ),
);
