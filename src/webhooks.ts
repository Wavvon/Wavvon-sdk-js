import type { IncomingMessage, ServerResponse } from "node:http";
import { ed25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, constantTimeEqual, hexToBytes, u64le, utf8 } from "./bytes.js";
import { WebhookVerificationError } from "./errors.js";
import type { HubEvent } from "./events.js";

// ---------------------------------------------------------------------------
// Wire shapes (Wavvon-server crates/hub/src/routes/app_models.rs)
// ---------------------------------------------------------------------------

export interface AuthorInfo {
  pubkey: string;
  display_name?: string;
}

export interface SlashInvocation {
  type: "slash_command";
  hub_url: string;
  channel_id: string;
  message_id_hint: string;
  author: AuthorInfo;
  command: string;
  args_raw: string;
  args_tokens: string[];
}

export interface ComponentInteraction {
  type: "component_interaction";
  hub_url: string;
  channel_id: string;
  message_id: string;
  custom_id: string;
  values: string[];
  user: AuthorInfo;
}

/** A verified dispatch whose `type` this SDK does not know. Delivered, never dropped. */
export interface UnknownDispatch {
  type: "unknown";
  rawType: string;
  raw: Record<string, unknown>;
}

export type Dispatch = SlashInvocation | ComponentInteraction | UnknownDispatch;

export interface Embed {
  title?: string;
  url?: string;
  description?: string;
  color?: string;
  fields?: { name: string; value: string; inline?: boolean }[];
  thumbnail_url?: string;
  image_url?: string;
  footer?: { text: string };
}

export interface AppComponent {
  type: "button" | "select";
  custom_id: string;
  label?: string;
  style?: string;
  disabled?: boolean;
  placeholder?: string;
  min_values?: number;
  max_values?: number;
  options?: { label: string; value: string; description?: string }[];
}

export interface ComponentRow {
  type: "row";
  components: AppComponent[];
}

export interface GameLaunchCard {
  entry_url: string;
  name: string;
  description?: string;
  thumbnail_url?: string;
}

/** What a slash command handler answers. */
export interface AppResponse {
  reply?: {
    body: string;
    embeds?: Embed[];
    components?: ComponentRow[];
    reply_to?: string;
  };
  /** Only the invoker sees the reply. */
  ephemeral?: boolean;
  reactions?: { message_id: string; emoji: string }[];
  /** The app will post later on its own. */
  defer?: boolean;
  /** A "Play" card attached to the reply; ignored without a reply. */
  game?: GameLaunchCard;
}

/** What a component interaction handler answers. */
export interface ComponentResponse {
  update?: { body?: string; components?: ComponentRow[] };
  ephemeral_reply?: { body: string };
  defer?: boolean;
}

// ---------------------------------------------------------------------------
// Signing bytes (wire-format.md, "Webhook delivery")
// ---------------------------------------------------------------------------

/** `"wavvon/webhook-delivery/v1\0" || u64le(timestamp) || body`. */
export function webhookDeliverySigningBytes(timestamp: bigint | number, body: Uint8Array): Uint8Array {
  return concatBytes(utf8("wavvon/webhook-delivery/v1\0"), u64le(BigInt(timestamp)), body);
}

/**
 * The HMAC key for an outgoing webhook: HKDF-SHA256 over the secret's decoded
 * bytes, salt "wavvon-webhook-signing", empty info. A string is the secret as
 * the admin was shown it (base64url, no padding); bytes are the decoded secret.
 */
export function outgoingWebhookSigningKey(secret: string | Uint8Array): Uint8Array {
  const raw = typeof secret === "string" ? base64UrlDecode(secret.trim()) : secret;
  return hkdf(sha256, raw, utf8("wavvon-webhook-signing"), new Uint8Array(0), 32);
}

function base64UrlDecode(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new TypeError("secret is not base64url");
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export type HeaderBag = Headers | Record<string, string | string[] | undefined>;

export interface VerifyOptions {
  /** Unix seconds; defaults to the clock. */
  now?: number;
  /** Maximum |now - X-Wavvon-Timestamp|. Default 300 s. */
  toleranceSec?: number;
}

function header(headers: HeaderBag, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === want) return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
}

function signedTimestamp(headers: HeaderBag, opts: VerifyOptions): { ts: bigint; sig: Uint8Array } {
  const sigHex = header(headers, "X-Wavvon-Signature-V1");
  const tsText = header(headers, "X-Wavvon-Timestamp");
  // The body-only X-Wavvon-Signature is deliberately not accepted: on its own
  // a captured request replays forever.
  if (!sigHex || !tsText) {
    throw new WebhookVerificationError("missing X-Wavvon-Signature-V1 or X-Wavvon-Timestamp");
  }
  if (!/^\d{1,20}$/.test(tsText)) throw new WebhookVerificationError("malformed X-Wavvon-Timestamp");
  const ts = BigInt(tsText);
  const now = BigInt(Math.floor(opts.now ?? Date.now() / 1000));
  const skew = ts > now ? ts - now : now - ts;
  if (skew > BigInt(opts.toleranceSec ?? 300)) {
    throw new WebhookVerificationError("timestamp outside the allowed window");
  }
  try {
    return { ts, sig: hexToBytes(sigHex) };
  } catch {
    throw new WebhookVerificationError("malformed signature");
  }
}

const asBytes = (body: Uint8Array | string): Uint8Array => (typeof body === "string" ? utf8(body) : body);

function parseJson(body: Uint8Array): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(new TextDecoder().decode(body));
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // reported below
  }
  throw new WebhookVerificationError("body is not a JSON object");
}

/**
 * Verifies a slash command or component dispatch and decodes it. `hubPublicKey`
 * is the hub's key as the program pinned it (GET /info `public_key`); the
 * X-Wavvon-Hub-Pubkey header is only compared against it, never trusted.
 * Pass the raw request bytes: re-serialised JSON will not verify.
 */
export function verifyDispatch(
  headers: HeaderBag,
  rawBody: Uint8Array | string,
  hubPublicKey: string,
  opts: VerifyOptions = {},
): Dispatch {
  const body = asBytes(rawBody);
  const sent = header(headers, "X-Wavvon-Hub-Pubkey");
  if (sent !== undefined && sent.toLowerCase() !== hubPublicKey.toLowerCase()) {
    throw new WebhookVerificationError("signed by a different hub");
  }
  const { ts, sig } = signedTimestamp(headers, opts);
  let ok: boolean;
  try {
    ok = ed25519.verify(sig, webhookDeliverySigningBytes(ts, body), hexToBytes(hubPublicKey));
  } catch {
    ok = false;
  }
  if (!ok) throw new WebhookVerificationError("bad signature");
  const raw = parseJson(body);
  if (raw.type === "slash_command" || raw.type === "component_interaction") {
    return raw as unknown as Dispatch;
  }
  return { type: "unknown", rawType: String(raw.type), raw };
}

/** The outgoing-webhook envelope: a hub_event plus delivery fields. */
export type OutgoingWebhookEvent = HubEvent & { webhook_id?: string; truncated?: boolean };

/**
 * Verifies an outgoing-webhook delivery (HMAC-SHA256) and decodes its
 * hub_event envelope. `secret` is what the admin copied when the webhook was
 * created or rotated.
 */
export function verifyOutgoingWebhook(
  headers: HeaderBag,
  rawBody: Uint8Array | string,
  secret: string | Uint8Array,
  opts: VerifyOptions = {},
): OutgoingWebhookEvent {
  const body = asBytes(rawBody);
  const { ts, sig } = signedTimestamp(headers, opts);
  const expected = hmac(sha256, outgoingWebhookSigningKey(secret), webhookDeliverySigningBytes(ts, body));
  if (!constantTimeEqual(sig, expected)) throw new WebhookVerificationError("bad signature");
  return parseJson(body) as unknown as OutgoingWebhookEvent;
}

// ---------------------------------------------------------------------------
// A handler: Request in, Response out
// ---------------------------------------------------------------------------

export interface DispatchHandlerOptions extends VerifyOptions {
  hubPublicKey: string;
  onSlashCommand?: (inv: SlashInvocation) => AppResponse | Promise<AppResponse>;
  onComponent?: (inv: ComponentInteraction) => ComponentResponse | Promise<ComponentResponse>;
  /** A verified dispatch of a type this SDK does not know. Default: answer `{}`. */
  onUnknown?: (inv: UnknownDispatch) => unknown;
}

/**
 * A fetch-style handler for the app's webhook_url. Refuses anything that does
 * not verify with 401; answers a verified dispatch with the handler's JSON.
 * The hub waits 5 s for the answer.
 */
export function createDispatchHandler(opts: DispatchHandlerOptions): (req: Request) => Promise<Response> {
  return async (req) => {
    if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
    const body = new Uint8Array(await req.arrayBuffer());
    let dispatch: Dispatch;
    try {
      dispatch = verifyDispatch(req.headers, body, opts.hubPublicKey, opts);
    } catch (e) {
      if (e instanceof WebhookVerificationError) return new Response(e.message, { status: 401 });
      throw e;
    }
    let answer: unknown;
    if (dispatch.type === "slash_command") answer = await opts.onSlashCommand?.(dispatch);
    else if (dispatch.type === "component_interaction") answer = await opts.onComponent?.(dispatch);
    else answer = await opts.onUnknown?.(dispatch);
    return Response.json(answer ?? {});
  };
}

/** Adapts a fetch-style handler to `http.createServer`. */
export function toNodeListener(
  handler: (req: Request) => Promise<Response>,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const chunks: Uint8Array[] = [];
    req.on("data", (c: Uint8Array) => chunks.push(c));
    req.on("end", async () => {
      try {
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) {
          if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
        }
        const hasBody = req.method !== "GET" && req.method !== "HEAD";
        const response = await handler(
          new Request(`http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`, {
            method: req.method,
            headers,
            body: hasBody ? Buffer.concat(chunks) : undefined,
          }),
        );
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(new Uint8Array(await response.arrayBuffer()));
      } catch (e) {
        console.error(e);
        res.writeHead(500).end();
      }
    });
  };
}
