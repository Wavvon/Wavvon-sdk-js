import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex, concatBytes, hexToBytes, utf8 } from "./bytes.js";
import { AuthSchemeError, HubError } from "./errors.js";
import { fetchWithRetry, isTransientStatus, type RetryOptions } from "./retry.js";

export const AUTH_CHALLENGE_SCHEME = "tagged-v1";
export const BOUND_AUTH_CHALLENGE_SCHEME = "tagged-v2";
const AUTH_CHALLENGE_LEN = 32;

/** A keypair the program holds. The seed never leaves this object. */
export interface Identity {
  /** Ed25519 public key, lowercase hex. */
  readonly publicKey: string;
  sign(message: Uint8Array): Uint8Array;
}

/**
 * Builds an Identity from a 32-byte Ed25519 seed (hex or bytes) that the
 * operator keeps in a file or environment variable. The SDK never sends the
 * seed anywhere; only signatures leave the process.
 */
export function identityFromSeed(seed: string | Uint8Array): Identity {
  const secret = typeof seed === "string" ? hexToBytes(seed.trim()) : Uint8Array.from(seed);
  if (secret.length !== 32) throw new TypeError("an Ed25519 seed is 32 bytes");
  const publicKey = bytesToHex(ed25519.getPublicKey(secret));
  return { publicKey, sign: (message) => ed25519.sign(message, secret) };
}

/**
 * The bytes a client signs to answer a challenge (wire-format.md, "Auth
 * challenge answer"). `tagged-v2` binds the answer to the server signed in to:
 * the tag, the server public key (u32 LE length, lowercase hex), then the
 * challenge. `serverPubkey` must come from that server's own `/info`, never
 * from the challenge response, or a hostile hub could relay another hub's
 * challenge and sign in there as this identity. `tagged-v1` (older hubs) is
 * the tag plus the challenge. A missing or unknown scheme is refused rather
 * than guessed at.
 */
export function authChallengeSigningBytes(
  challenge: Uint8Array,
  scheme?: string | null,
  serverPubkey?: string,
): Uint8Array {
  if (scheme === BOUND_AUTH_CHALLENGE_SCHEME || scheme === AUTH_CHALLENGE_SCHEME) {
    if (challenge.length !== AUTH_CHALLENGE_LEN) {
      throw new AuthSchemeError(`auth challenge is ${challenge.length} bytes, expected ${AUTH_CHALLENGE_LEN}`);
    }
  }
  if (scheme === BOUND_AUTH_CHALLENGE_SCHEME) {
    if (!serverPubkey) throw new TypeError("tagged-v2 needs the server public key");
    const key = utf8(serverPubkey);
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, key.length, true);
    return concatBytes(utf8("wavvon/auth-challenge/v2\0"), len, key, challenge);
  }
  if (scheme === AUTH_CHALLENGE_SCHEME) {
    return concatBytes(utf8("wavvon/auth-challenge/v1\0"), challenge);
  }
  throw new AuthSchemeError(
    scheme == null ? "the hub named no auth challenge scheme" : `unknown auth challenge scheme "${scheme}"`,
  );
}

export interface Session {
  token: string;
  /** "member", or "lobby" on a hub that holds newcomers back. */
  scope: string;
  /** The identity the hub attributes this session's actions to. */
  canonicalPubkey: string;
}

export interface AuthenticateOptions {
  /** Needed once, on an invite_only hub, to be admitted. Ignored for members. */
  inviteCode?: string;
  retry?: RetryOptions;
  fetch?: typeof fetch;
}

/**
 * Challenge, sign, verify. A transient failure at either step restarts from a
 * fresh challenge, because the hub drops a pending challenge as soon as verify
 * reads it.
 */
export async function authenticate(
  hubUrl: string,
  identity: Identity,
  opts: AuthenticateOptions = {},
): Promise<Session> {
  const doFetch = opts.fetch ?? fetch;
  const base = hubUrl.replace(/\/+$/, "");
  const post = (path: string, body: unknown, signal: AbortSignal) =>
    doFetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });

  let serverPubkey: string | undefined;
  const res = await fetchWithRetry(async (signal) => {
    const ch = await post("/auth/challenge", { public_key: identity.publicKey }, signal);
    if (!ch.ok) return ch;
    const { challenge, scheme } = (await ch.json()) as { challenge: string; scheme?: string | null };
    if (scheme === BOUND_AUTH_CHALLENGE_SCHEME && serverPubkey === undefined) {
      const info = await doFetch(`${base}/info`, { signal });
      if (!info.ok) return info;
      serverPubkey = ((await info.json()) as { public_key: string }).public_key;
    }
    const signature = identity.sign(authChallengeSigningBytes(hexToBytes(challenge), scheme, serverPubkey));
    const verifyBody: Record<string, unknown> = {
      public_key: identity.publicKey,
      challenge,
      signature: bytesToHex(signature),
    };
    if (opts.inviteCode !== undefined) verifyBody.invite_code = opts.inviteCode;
    return post("/auth/verify", verifyBody, signal);
  }, opts.retry);

  if (!res.ok || isTransientStatus(res.status)) throw new HubError(res.status, await res.text());
  const body = (await res.json()) as { token: string; scope?: string; canonical_pubkey?: string };
  return {
    token: body.token,
    scope: body.scope ?? "member",
    canonicalPubkey: body.canonical_pubkey || identity.publicKey,
  };
}
