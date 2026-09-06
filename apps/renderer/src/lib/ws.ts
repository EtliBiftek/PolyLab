/**
 * WebSocket client for the sidecar event stream (contract: docs/EVENTS.md).
 *
 * - JSON text frames with a discriminating `type`
 * - auto-reconnect with capped backoff
 * - `ping`/`pong` keepalive used for the latency readout
 * - emits synthetic `status` events (`connecting` | `online` | `offline`)
 */
export type ConnectionStatus = "connecting" | "online" | "offline";

export interface WsStatusEvent {
  status: ConnectionStatus;
}

type Handler = (payload: unknown) => void;

const PING_INTERVAL_MS = 10_000;
const RECONNECT_BASE_MS = 700;
const RECONNECT_MAX_MS = 5_000;
const OUTBOX_MAX = 100;

export class WsClient {
  private socket: WebSocket | null = null;
  private handlers = new Map<string, Set<Handler>>();
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastPingSentAt = 0;
  private disposed = false;
  private outbox: string[] = [];

  constructor(
    private readonly url: string,
    private readonly token: string | null,
  ) {}

  connect(): void {
    if (this.disposed || this.socket != null) return;
    this.emit("status", { status: "connecting" } satisfies WsStatusEvent);

    const url = this.token ? `${this.url}?token=${encodeURIComponent(this.token)}` : this.url;
    const socket = new WebSocket(url, "polylab-v1");
    this.socket = socket;

    socket.onopen = () => {
      this.reconnectAttempt = 0;
      this.flushOutbox();
      this.startPing();
    };
    socket.onmessage = (event) => this.onMessage(event.data);
    socket.onclose = () => this.onDisconnect();
    socket.onerror = () => {
      /* onclose follows; nothing to do here */
    };
  }

  private onMessage(raw: unknown): void {
    if (typeof raw !== "string") return;
    let parsed: { type?: string };
    try {
      parsed = JSON.parse(raw) as { type?: string };
    } catch {
      return;
    }
    if (typeof parsed.type !== "string") return;

    switch (parsed.type) {
      case "hello":
        this.emit("hello", parsed);
        this.emit("status", { status: "online" } satisfies WsStatusEvent);
        this.ping();
        break;
      case "pong":
        this.emit("pong", { rttMs: this.lastPingSentAt ? Date.now() - this.lastPingSentAt : null });
        break;
      default:
        this.emit(parsed.type, parsed);
    }
  }

  private onDisconnect(): void {
    this.stopPing();
    this.socket = null;
    this.emit("status", { status: "offline" } satisfies WsStatusEvent);
    if (this.disposed) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempt, RECONNECT_MAX_MS);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private startPing(): void {
    this.stopPing();
    this.ping();
    this.pingTimer = setInterval(() => this.ping(), PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer != null) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private ping(): void {
    this.lastPingSentAt = Date.now();
    this.send("ping");
  }

  private flushOutbox(): void {
    const socket = this.socket;
    if (socket?.readyState !== WebSocket.OPEN || this.outbox.length === 0) return;
    const queued = this.outbox;
    this.outbox = [];
    for (const frame of queued) socket.send(frame);
  }

  send(type: string, payload: Record<string, unknown> = {}): void {
    const frame = JSON.stringify({ type, ...payload });
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(frame);
      return;
    }
    // Never buffer keepalive frames, but don't silently lose user actions.
    if (type !== "ping") {
      this.outbox.push(frame);
      if (this.outbox.length > OUTBOX_MAX) this.outbox.shift();
    }
  }

  on(type: string, handler: Handler): () => void {
    const set = this.handlers.get(type) ?? new Set<Handler>();
    set.add(handler);
    this.handlers.set(type, set);
    return () => set.delete(handler);
  }

  private emit(type: string, payload: unknown): void {
    for (const handler of this.handlers.get(type) ?? []) handler(payload);
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer != null) clearTimeout(this.reconnectTimer);
    this.stopPing();
    this.outbox = [];
    this.socket?.close();
    this.socket = null;
  }
}
