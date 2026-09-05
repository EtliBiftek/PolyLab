import { useEffect } from "react";

import { getHealth } from "../lib/api";
import { backendInfo } from "../lib/backend";
import { wsClient } from "../lib/connection";
import { WsClient, type ConnectionStatus } from "../lib/ws";
import { useChat } from "../stores/chat";
import { useConnection } from "../stores/connection";

const HEALTH_POLL_MS = 10_000;

interface HelloEvent {
  type: "hello";
  name: string;
  version: string;
}

interface PongEvent {
  type: "pong";
  rttMs: number | null;
}

/**
 * Owns the sidecar connection for the whole app:
 *  - WebSocket: liveness + latency (primary signal) + chat event fan-in
 *  - HTTP /health poll: fallback when the WS upgrade is not possible (e.g. some
 *    browser-preview proxies), and the source of core name/version before `hello`.
 */
export function useBackendConnection(): void {
  useEffect(() => {
    const info = backendInfo();
    const client: WsClient = wsClient();

    const offStatus = client.on("status", (payload) => {
      const { status } = payload as { status: ConnectionStatus };
      if (status === "online") {
        useConnection.getState().markOnline("ws");
      } else if (status === "connecting") {
        useConnection.getState().setStatus("connecting");
      } else {
        // Only trust WS-down if health also fails; handled by the poll below.
        useConnection.getState().setStatus("connecting");
      }
    });

    const offHello = client.on("hello", (payload) => {
      const hello = payload as HelloEvent;
      useConnection.getState().setCoreInfo(hello.name, hello.version);
    });

    const offPong = client.on("pong", (payload) => {
      const pong = payload as PongEvent;
      useConnection.getState().setLatency(pong.rttMs);
    });

    const offChatEvents = useChat.getState().wireEvents();

    client.connect();

    let cancelled = false;
    const pollHealth = async () => {
      try {
        const health = await getHealth();
        if (!cancelled) {
          useConnection.getState().setCoreInfo(health.name, health.version);
          useConnection.getState().markOnline("health");
        }
      } catch (error) {
        if (!cancelled && useConnection.getState().status !== "online") {
          useConnection.getState().markOffline(String(error));
        }
      }
    };
    void pollHealth();
    const pollTimer = setInterval(() => void pollHealth(), HEALTH_POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(pollTimer);
      offStatus();
      offHello();
      offPong();
      offChatEvents();
      void info;
    };
  }, []);
}
