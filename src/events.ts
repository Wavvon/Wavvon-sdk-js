import type { components } from "./generated/schema.js";
import { backoffDelay, type RetryOptions } from "./retry.js";

// ---------------------------------------------------------------------------
// Server -> client frames this SDK knows (ws-protocol.md, checked against
// Wavvon-server crates/hub/src/routes/chat_models.rs). Every other `type`
// arrives as UnknownEvent with the raw frame.
// ---------------------------------------------------------------------------

export type Message = components["schemas"]["Message"];

/** One envelope for live push, replay and outgoing webhooks (apps.md §5). */
export interface HubEvent {
  type: "hub_event";
  seq: number;
  /** e.g. `member.joined`, `message.created`. */
  event: string;
  hub_url: string;
  at: number;
  payload: Record<string, unknown>;
  /** Replay only, and only when the audit row has them. */
  actor_pubkey?: string;
  target_pubkey?: string;
  channel_id?: string;
  replayed?: true;
}

export type KnownEvent =
  | { type: "hello"; live_seq: number }
  | { type: "error"; context: string; message: string }
  | { type: "pong"; nonce: number; outbound_loss_pct?: number }
  | { type: "message"; channel_id: string; message: Message }
  | { type: "message_edited"; channel_id: string; message: Message }
  | { type: "message_deleted"; channel_id: string; message_id: string }
  | { type: "message_pinned"; channel_id: string; message_id: string }
  | { type: "message_unpinned"; channel_id: string; message_id: string }
  | {
      type: "reactions_updated";
      channel_id: string;
      message_id: string;
      reactions: { emoji: string; count: number; me: boolean }[];
    }
  | { type: "typing"; channel_id: string; public_key: string; display_name: string | null; typing: boolean }
  | {
      type: "dm";
      conversation_id: string;
      sender: string;
      sender_name: string | null;
      content: string;
      timestamp: number;
    }
  | HubEvent
  | { type: "replay_complete"; replayed: number; live_from_seq: number }
  | { type: "replay_unavailable"; earliest_seq: number; earliest_at: number }
  | { type: "app_launch"; app_id: string; title: string; description: string; channel_id: string }
  | {
      type: "app_open";
      app_id: string;
      channel_id: string;
      mini_app_url: string;
      session_token: string;
      requires_camera: boolean;
    }
  | { type: "app_close"; app_id: string; channel_id: string }
  | { type: "mini_app_message"; app_id: string; channel_id: string; payload: string; from_pubkey?: string };

/** A frame of a type this SDK does not model (or not JSON at all). Never swallowed. */
export interface UnknownEvent {
  type: "unknown";
  /** The frame's own `type`, `"binary"` for a binary frame, `""` if unparseable. */
  rawType: string;
  raw: unknown;
}

export type WsEvent = KnownEvent | UnknownEvent;

const KNOWN_TYPES = new Set<string>([
  "hello",
  "error",
  "pong",
  "message",
  "message_edited",
  "message_deleted",
  "message_pinned",
  "message_unpinned",
  "reactions_updated",
  "typing",
  "dm",
  "hub_event",
  "replay_complete",
  "replay_unavailable",
  "app_launch",
  "app_open",
  "app_close",
  "mini_app_message",
]);

/** Turns one WebSocket frame into a typed event. Exported for tests. */
export function parseFrame(data: unknown): WsEvent {
  if (typeof data !== "string") return { type: "unknown", rawType: "binary", raw: data };
  let frame: unknown;
  try {
    frame = JSON.parse(data);
  } catch {
    return { type: "unknown", rawType: "", raw: data };
  }
  const t = (frame as { type?: unknown } | null)?.type;
  if (typeof t === "string" && KNOWN_TYPES.has(t)) return frame as KnownEvent;
  return { type: "unknown", rawType: typeof t === "string" ? t : "", raw: frame };
}

/** Client -> server frames a tier-1 program sends. */
export type ClientMessage =
  | { type: "subscribe"; channel_id: string }
  | { type: "unsubscribe"; channel_id: string }
  | { type: "typing"; channel_id: string; typing: boolean }
  | { type: "ping"; nonce: number }
  | { type: "resume"; since_seq: number }
  | { type: "component_interaction"; message_id: string; custom_id: string; values?: string[] }
  | { type: "app_announce"; channel_id: string; title: string; description: string }
  | { type: "app_dismiss"; channel_id: string }
  | { type: "mini_app_message"; app_id: string; channel_id: string; payload: string; to_pubkey?: string };

// ---------------------------------------------------------------------------
// The socket
// ---------------------------------------------------------------------------

export type ConnectionState = "connecting" | "open" | "reconnecting" | "closed";

/** The subset of the WHATWG WebSocket this SDK uses. */
export interface WebSocketLike {
  readonly readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}
export type WebSocketCtor = new (url: string) => WebSocketLike;

export interface EventStreamDeps {
  /** A ws(s):// URL carrying a current token. */
  url: () => Promise<string>;
  /** Called when a connection dies before `hello`: the token may be dead. */
  reauthenticate: () => Promise<void>;
  WebSocket: WebSocketCtor;
  retry?: RetryOptions;
}

export interface EventStreamOptions {
  /**
   * Replay hub events after this seq on the first connect (an app persisting
   * its position across restarts). Without it the stream starts from now.
   */
  sinceSeq?: number;
}

type Handler<E> = (event: E) => void;

/**
 * One hub WebSocket that reconnects on its own. Tracks the last hub_event seq
 * and sends `resume` after every reconnect, so an app misses nothing inside
 * the hub's 72-hour window; `replay_unavailable` is delivered like any other
 * event when it falls outside. The hub only honours `resume` (and only pushes
 * hub_event) for an identity whose app profile existed when the socket
 * connected: register the profile first.
 */
export class EventStream {
  private ws: WebSocketLike | undefined;
  private handlers = new Map<string, Set<Handler<never>>>();
  private stateHandlers = new Set<Handler<ConnectionState>>();
  private attempt = 0;
  private stopped = false;
  private _state: ConnectionState = "connecting";
  /** Highest hub_event seq seen (or the hub's live seq at first connect). */
  lastSeq: number | undefined;

  constructor(
    private readonly deps: EventStreamDeps,
    opts: EventStreamOptions = {},
  ) {
    this.lastSeq = opts.sinceSeq;
    void this.open();
  }

  get state(): ConnectionState {
    return this._state;
  }

  onStateChange(fn: Handler<ConnectionState>): () => void {
    this.stateHandlers.add(fn);
    return () => this.stateHandlers.delete(fn);
  }

  /** Subscribe to one event type, `"unknown"`, or `"*"` for everything. Returns an unsubscribe. */
  on<T extends WsEvent["type"] | "*">(
    type: T,
    fn: Handler<T extends "*" ? WsEvent : Extract<WsEvent, { type: T }>>,
  ): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(fn as Handler<never>);
    return () => set.delete(fn as Handler<never>);
  }

  send(message: ClientMessage): void {
    if (!this.ws || this._state !== "open") throw new Error(`socket is ${this._state}, not open`);
    this.ws.send(JSON.stringify(message));
  }

  /** Mini-app host: show a launch card in a channel. */
  announceApp(channelId: string, title: string, description: string): void {
    this.send({ type: "app_announce", channel_id: channelId, title, description });
  }

  /** Mini-app host: close the session; clients dismiss their webviews. */
  dismissApp(channelId: string): void {
    this.send({ type: "app_dismiss", channel_id: channelId });
  }

  /**
   * Mini-app host: relay an opaque payload to one joined player's mini-app.
   * Players' messages arrive as `mini_app_message` events with `from_pubkey`.
   */
  sendMiniAppMessage(appId: string, channelId: string, toPubkey: string, payload: string): void {
    this.send({ type: "mini_app_message", app_id: appId, channel_id: channelId, payload, to_pubkey: toPubkey });
  }

  close(): void {
    this.stopped = true;
    this.ws?.close();
    this.setState("closed");
  }

  private setState(s: ConnectionState) {
    if (s === this._state) return;
    this._state = s;
    for (const fn of this.stateHandlers) fn(s);
  }

  private emit(event: WsEvent) {
    for (const key of [event.type, "*"]) {
      for (const fn of this.handlers.get(key) ?? []) (fn as Handler<WsEvent>)(event);
    }
  }

  private async open(): Promise<void> {
    let url: string;
    try {
      url = await this.deps.url();
    } catch {
      return this.scheduleReconnect(false);
    }
    if (this.stopped) return;
    const ws = new this.deps.WebSocket(url);
    this.ws = ws;
    let greeted = false;
    ws.onmessage = (ev) => {
      const event = parseFrame(ev.data);
      if (event.type === "hello") {
        greeted = true;
        this.attempt = 0;
        this.setState("open");
        if (this.lastSeq === undefined) this.lastSeq = event.live_seq;
        else ws.send(JSON.stringify({ type: "resume", since_seq: this.lastSeq }));
      } else if (event.type === "hub_event") {
        // Live events that arrived during a replay are flushed after it and
        // can repeat what the replay already carried.
        if (this.lastSeq !== undefined && event.seq <= this.lastSeq) return;
        this.lastSeq = event.seq;
      }
      this.emit(event);
    };
    ws.onclose = () => {
      if (this.ws === ws) this.scheduleReconnect(!greeted);
    };
    ws.onerror = () => {
      // onclose follows and does the work.
    };
  }

  private async scheduleReconnect(diedBeforeHello: boolean) {
    if (this.stopped) return;
    this.setState("reconnecting");
    this.attempt++;
    await new Promise((r) => setTimeout(r, backoffDelay(this.attempt, this.deps.retry)));
    if (this.stopped) return;
    if (diedBeforeHello) {
      // A refused upgrade is indistinguishable from a dropped one in the
      // browser API; a fresh session costs one login and rules out the token.
      await this.deps.reauthenticate().catch(() => {});
    }
    void this.open();
  }
}
