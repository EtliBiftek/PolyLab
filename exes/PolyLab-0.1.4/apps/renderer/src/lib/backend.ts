/**
 * Resolves where the sidecar lives.
 *
 * - Inside Electron: preload injected `window.polylab.sidecar` (port + token) — talk to
 *   127.0.0.1:{port} directly.
 * - In a plain browser (renderer-only dev / sandbox preview): same-origin relative URLs;
 *   the Vite dev server proxies /health, /api and /ws to the sidecar. A fixed dev token
 *   is used because the browser has no way to learn the session token. Dev-only: the
 *   sidecar binds to 127.0.0.1 exclusively.
 */
import type { PolylabBridge } from "../types/global";

export interface BackendInfo {
  /** Base URL for REST ("" = same origin). */
  baseUrl: string;
  /** Absolute WebSocket URL. */
  wsUrl: string;
  /** Session token; null outside dev. */
  token: string | null;
}

const DEV_TOKEN = import.meta.env.VITE_POLYLAB_DEV_TOKEN ?? "dev-token";

export function isElectron(): boolean {
  return typeof window !== "undefined" && window.polylab?.sidecar != null;
}

export function bridge(): PolylabBridge | undefined {
  return typeof window === "undefined" ? undefined : window.polylab;
}

export function backendInfo(): BackendInfo {
  const sidecar = bridge()?.sidecar;
  if (sidecar) {
    return {
      baseUrl: `http://127.0.0.1:${sidecar.port}`,
      wsUrl: `ws://127.0.0.1:${sidecar.port}/ws`,
      token: sidecar.token,
    };
  }
  const wsProtocol = window.location.protocol === "https:" ? "wss" : "ws";
  return {
    baseUrl: "",
    wsUrl: `${wsProtocol}://${window.location.host}/ws`,
    token: import.meta.env.DEV ? DEV_TOKEN : null,
  };
}
