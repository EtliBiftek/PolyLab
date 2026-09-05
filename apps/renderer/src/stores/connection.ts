import { create } from "zustand";

import type { ConnectionStatus } from "../lib/ws";

interface ConnectionState {
  status: ConnectionStatus;
  /** Round-trip time of the last ping; null when only HTTP health is available. */
  latencyMs: number | null;
  coreName: string | null;
  coreVersion: string | null;
  lastError: string | null;

  setStatus: (status: ConnectionStatus) => void;
  markOnline: (source: "ws" | "health") => void;
  markOffline: (reason?: string) => void;
  setLatency: (latencyMs: number | null) => void;
  setCoreInfo: (name: string, version: string) => void;
}

export const useConnection = create<ConnectionState>((set) => ({
  status: "connecting",
  latencyMs: null,
  coreName: null,
  coreVersion: null,
  lastError: null,

  setStatus: (status) => set({ status }),
  markOnline: (source) =>
    set((state) =>
      source === "health" && state.status === "online"
        ? { lastError: null } // keep WS-provided latency if we are already online
        : { status: "online", lastError: null },
    ),
  markOffline: (reason) => set({ status: "offline", latencyMs: null, lastError: reason ?? null }),
  setLatency: (latencyMs) => set({ latencyMs }),
  setCoreInfo: (coreName, coreVersion) => set({ coreName, coreVersion }),
}));
