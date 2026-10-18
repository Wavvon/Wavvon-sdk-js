import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex, concatBytes, hexToBytes, utf8 } from "./bytes.js";
import { AuthSchemeError, HubError } from "./errors.js";
import { fetchWithRetry, isTransientStatus, type RetryOptions } from "./retry.js";

export const AUTH_CHALLENGE_SCHEME = "tagged-v1";
/** The only length a raw (untagged) challenge is ever signed at. */
export const AUTH_CHALLENGE_LEN = 32;

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
 * challenge answer"). Named `tagged-v1`: the domain prefix plus the challenge.
 * No scheme (an older hub): the raw challenge, and only at exactly 32 bytes, so
 * this can never be used to sign arbitrary bytes. Any other scheme is refused
 * rather than guessed at.
 */
export function authChallengeSigningBytes(challenge: Uint8Array, scheme?: string | null): Uint8Array {
  if (scheme === AUTH_CHALLENGE_SCHEME) {
    return concatBytes(utf8("wavvon/auth-challenge/v1\0"), challenge);
  }
  if (scheme === undefined || scheme === null) {
    if (challenge.length !== AUTH_CHALLENGE_LEN) {
      throw new AuthSchemeError(
        `refusing to sign a raw ${challenge.length}-byte challenge; only ${AUTH_CHALLENGE_LEN} bytes are ever signed raw`,
      );
    }
    return challenge;
  }
  throw new AuthSchemeError(`unknown auth challenge scheme "${scheme}"`);
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

  const res = await fetchWithRetry(async (signal) => {
    const ch = await post("/auth/challenge", { public_key: identity.publicKey }, signal);
    if (!ch.ok) return ch;
    const { challenge, scheme } = (await ch.json()) as { challenge: string; scheme?: string | null };
    const signature = identity.sign(authChallengeSigningBytes(hexToBytes(challenge), scheme));
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
