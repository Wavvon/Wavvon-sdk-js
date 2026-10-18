import createClient, { type Client } from "openapi-fetch";
import { authenticate, identityFromSeed, type Identity, type Session } from "./auth.js";
import { HubError, UnsupportedByHubError } from "./errors.js";
import { EventStream, type EventStreamOptions, type WebSocketCtor } from "./events.js";
import type { components, paths } from "./generated/schema.js";
import { fetchWithRetry, type RetryOptions } from "./retry.js";

export type HubInfo = components["schemas"]["HubInfo"];
type Body<P extends keyof paths, M extends "put"> = paths[P][M] extends {
  requestBody?: { content: { "application/json": infer B } };
}
  ? B
  : never;
export type AppProfile = Body<"/me/app/profile", "put">;
export type AppCommand = Body<"/me/app/commands", "put">["commands"][number];
export type AppSubscription = Body<"/me/app/subscriptions", "put">["subscriptions"][number];

/** One row of GET /me/events, with `payload` already parsed. */
export interface PolledEvent {
  id: string;
  event_type: string;
  payload: unknown;
  created_at: number;
}

export type SessionState = "signed-out" | "authenticating" | "ready";

export interface WavvonClientOptions {
  hubUrl: string;
  /** A 32-byte Ed25519 seed (hex or bytes), or an Identity you built. Never sent anywhere. */
  seed?: string | Uint8Array;
  identity?: Identity;
  /** Admits the program on an invite_only hub. */
  inviteCode?: string;
  retry?: RetryOptions;
  fetch?: typeof fetch;
  /** Defaults to globalThis.WebSocket (Node >= 22, browsers). */
  WebSocket?: WebSocketCtor;
}

/**
 * A program's connection to one hub: a session that renews itself, the
 * generated REST client (`rest`), capability checks, app registration and the
 * event stream.
 */
export class WavvonClient {
  readonly hubUrl: string;
  readonly identity: Identity;
  /** Typed REST client generated from openapi.yaml; bearer, retry and re-auth are built in. */
  readonly rest: Client<paths>;
  private session: Session | undefined;
  private loggingIn: Promise<Session> | undefined;
  private infoCache: HubInfo | undefined;
  private _state: SessionState = "signed-out";
  private stateHandlers = new Set<(s: SessionState) => void>();

  constructor(private readonly opts: WavvonClientOptions) {
    this.hubUrl = opts.hubUrl.replace(/\/+$/, "");
    if (opts.identity) this.identity = opts.identity;
    else if (opts.seed !== undefined) this.identity = identityFromSeed(opts.seed);
    else throw new TypeError("WavvonClient needs a seed or an identity");
    this.rest = createClient<paths>({ baseUrl: this.hubUrl, fetch: (req) => this.authedFetch(req) });
  }

  get state(): SessionState {
    return this._state;
  }

  /** "authenticating" after a dead session is the reconnecting state of REST. */
  onStateChange(fn: (s: SessionState) => void): () => void {
    this.stateHandlers.add(fn);
    return () => this.stateHandlers.delete(fn);
  }

  /** The current session, logging in if there is none. */
  async login(): Promise<Session> {
    return this.session ?? this.relogin(undefined);
  }

  /** The identity the hub attributes this program's actions to. */
  get canonicalPubkey(): string | undefined {
    return this.session?.canonicalPubkey;
  }

  private relogin(staleToken: string | undefined): Promise<Session> {
    // Someone else already replaced the token this caller saw fail.
    if (this.session && this.session.token !== staleToken) return Promise.resolve(this.session);
    this.loggingIn ??= (async () => {
      this.setState("authenticating");
      try {
        this.session = await authenticate(this.hubUrl, this.identity, {
          inviteCode: this.opts.inviteCode,
          retry: this.opts.retry,
          fetch: this.opts.fetch,
        });
        this.setState("ready");
        return this.session;
      } catch (e) {
        this.session = undefined;
        this.setState("signed-out");
        throw e;
      } finally {
        this.loggingIn = undefined;
      }
    })();
    return this.loggingIn;
  }

  private setState(s: SessionState) {
    if (s === this._state) return;
    this._state = s;
    for (const fn of this.stateHandlers) fn(s);
  }

  private async authedFetch(input: Request): Promise<Response> {
    const doFetch = this.opts.fetch ?? fetch;
    const send = (token: string) =>
      fetchWithRetry((signal) => {
        const req = new Request(input.clone(), { signal });
        req.headers.set("Authorization", `Bearer ${token}`);
        return doFetch(req);
      }, this.opts.retry);
    const { token } = await this.login();
    const res = await send(token);
    if (res.status !== 401) return res;
    await res.body?.cancel().catch(() => {});
    return send((await this.relogin(token)).token);
  }

  /** GET /info, cached; `refresh` re-reads it. */
  async info(refresh = false): Promise<HubInfo> {
    if (!this.infoCache || refresh) {
      const doFetch = this.opts.fetch ?? fetch;
      const res = await fetchWithRetry((signal) => doFetch(`${this.hubUrl}/info`, { signal }), this.opts.retry);
      if (!res.ok) throw new HubError(res.status, await res.text());
      this.infoCache = (await res.json()) as HubInfo;
    }
    return this.infoCache;
  }

  /** Whether the hub advertises `name`. Capabilities, never versions. */
  async hasCapability(name: string): Promise<boolean> {
    return ((await this.info()).capabilities ?? []).includes(name);
  }

  /** Throws UnsupportedByHubError unless the hub advertises `name`. */
  async requireCapability(name: string): Promise<void> {
    if (!(await this.hasCapability(name))) throw new UnsupportedByHubError(name);
  }

  // ---- app registration (apps.md §2), gated on `apps.register` ----

  /** Register or replace this identity's app profile. Do it before `connect()`. */
  async setAppProfile(profile: AppProfile): Promise<void> {
    await this.requireCapability("apps.register");
    ok(await this.rest.PUT("/me/app/profile", { body: profile }));
  }

  async setAppCommands(commands: AppCommand[]): Promise<void> {
    await this.requireCapability("apps.register");
    ok(await this.rest.PUT("/me/app/commands", { body: { commands } }));
  }

  /** A `message.*` subscription must name its channels. */
  async setAppSubscriptions(subscriptions: AppSubscription[]): Promise<void> {
    await this.requireCapability("apps.register");
    ok(await this.rest.PUT("/me/app/subscriptions", { body: { subscriptions } }));
  }

  // ---- events ----

  /** Opens the hub WebSocket. Reconnects, re-authenticates and resumes on its own. */
  connect(opts: EventStreamOptions = {}): EventStream {
    const WS = this.opts.WebSocket ?? (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
    if (!WS) throw new TypeError("no global WebSocket here (Node < 22?); pass the `ws` package as options.WebSocket");
    return new EventStream(
      {
        url: async () => {
          const { token } = await this.login();
          return `${this.hubUrl.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(token)}`;
        },
        reauthenticate: async () => {
          await this.relogin(this.session?.token);
        },
        WebSocket: WS,
        retry: this.opts.retry,
      },
      opts,
    );
  }

  /** GET /me/events: the polling transport, for a program that holds no socket. */
  async pollEvents(since?: number): Promise<PolledEvent[]> {
    const res = ok(await this.rest.GET("/me/events", { params: { query: since === undefined ? {} : { since } } }));
    const rows = res.events;
    if (!Array.isArray(rows)) throw new HubError(200, "GET /me/events answered without an events array");
    return rows.map((r) => ({ ...r, payload: parsePayload(r.payload) }));
  }

  /** DELETE /me/events: acknowledge polled events so they are not returned again. */
  async ackEvents(ids: string[]): Promise<void> {
    ok(await this.rest.DELETE("/me/events", { body: { ids } }));
  }
}

function parsePayload(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/** openapi-fetch result -> data, or a HubError carrying the hub's own words. */
export function ok<T>(result: { data?: T; error?: unknown; response: Response }): T {
  if (!result.response.ok) {
    const e = result.error;
    throw new HubError(result.response.status, typeof e === "string" ? e : JSON.stringify(e ?? ""));
  }
  return result.data as T;
}
