import { create } from "zustand";
import { persist } from "zustand/middleware";

import i18n, { DEFAULT_LANGUAGE, type AppLanguage } from "../i18n";

export type Mode = "chat" | "coding";
export type Theme = "light" | "dark";

interface SettingsState {
  language: AppLanguage;
  theme: Theme;
  mode: Mode;
  rightPanelOpen: boolean;
  settingsOpen: boolean;
  sidebarCollapsed: boolean;
  /** Model used for the next new conversation (single-model selection). */
  lastModelId: string | null;
  setLanguage: (language: AppLanguage) => void;
  setTheme: (theme: Theme) => void;
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
      theme: "light",
      mode: "chat",
      rightPanelOpen: false,
      settingsOpen: false,
      sidebarCollapsed: false,
      lastModelId: null,
      setLanguage: (language) => {
        void i18n.changeLanguage(language);
        set({ language });
      },
      setTheme: (theme) => {
        document.documentElement.dataset.theme = theme;
        set({ theme });
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
        theme: state.theme,
        mode: state.mode,
        lastModelId: state.lastModelId,
        sidebarCollapsed: state.sidebarCollapsed,
      }),
    },
  ),
);
