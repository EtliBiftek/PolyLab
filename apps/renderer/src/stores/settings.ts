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
  /** Section to open when the settings modal is requested (session only). */
  settingsRequest: "general" | "providers" | "groups" | "cost" | null;
  sidebarCollapsed: boolean;
  /** Command palette (⌘K) visibility. */
  paletteOpen: boolean;
  /** Persistent model-comparison browser visibility. */
  comparisonsOpen: boolean;
  /** Model used for the next new conversation (single-model selection). */
  lastModelId: string | null;
  /** Composer: Enter sends the message (Shift+Enter always inserts a newline). */
  sendOnEnter: boolean;
  /** Show message timestamps under the meta line. */
  showTimestamps: boolean;
  /** Web search for the next turns (OpenRouter web plugin). */
  webSearch: boolean;
  /** Monthly usage budget in USD; null = no warning. */
  monthlyBudgetUsd: number | null;
  setLanguage: (language: AppLanguage) => void;
  setTheme: (theme: Theme) => void;
  setMode: (mode: Mode) => void;
  toggleRightPanel: () => void;
  setSettingsOpen: (open: boolean) => void;
  /** Opens settings on the given tab (closes on next request). */
  requestSettings: (section: "general" | "providers" | "groups" | "cost") => void;
  setPaletteOpen: (open: boolean) => void;
  setComparisonsOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  setLastModelId: (modelId: string | null) => void;
  setSendOnEnter: (enabled: boolean) => void;
  setShowTimestamps: (enabled: boolean) => void;
  setWebSearch: (enabled: boolean) => void;
  setMonthlyBudgetUsd: (usd: number | null) => void;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      language: (i18n.language as AppLanguage) ?? DEFAULT_LANGUAGE,
      theme: "light",
      mode: "chat",
      rightPanelOpen: false,
      settingsOpen: false,
      settingsRequest: null,
      sidebarCollapsed: false,
      paletteOpen: false,
      comparisonsOpen: false,
      lastModelId: null,
      sendOnEnter: true,
      showTimestamps: false,
      webSearch: false,
      monthlyBudgetUsd: null,
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
      requestSettings: (settingsRequest) => set({ settingsRequest, settingsOpen: true }),
      setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
      setComparisonsOpen: (comparisonsOpen) => set({ comparisonsOpen }),
      toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      setLastModelId: (lastModelId) => set({ lastModelId }),
      setSendOnEnter: (sendOnEnter) => set({ sendOnEnter }),
      setShowTimestamps: (showTimestamps) => set({ showTimestamps }),
      setWebSearch: (webSearch) => set({ webSearch }),
      setMonthlyBudgetUsd: (monthlyBudgetUsd) => set({ monthlyBudgetUsd }),
    }),
    {
      name: "polylab-settings",
      partialize: (state) => ({
        language: state.language,
        theme: state.theme,
        mode: state.mode,
        lastModelId: state.lastModelId,
        sidebarCollapsed: state.sidebarCollapsed,
        sendOnEnter: state.sendOnEnter,
        showTimestamps: state.showTimestamps,
        webSearch: state.webSearch,
        monthlyBudgetUsd: state.monthlyBudgetUsd,
      }),
    },
  ),
);
