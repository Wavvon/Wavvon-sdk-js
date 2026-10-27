import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import { bytesToHex, hexToBytes, utf8 } from "../src/bytes.js";
import {
  AuthSchemeError,
  HubError,
  authChallengeSigningBytes,
  authenticate,
  identityFromSeed,
} from "../src/index.js";

const seed = "5a".repeat(32);
const c32 = new Uint8Array(32).fill(9);

describe("auth challenge signing rules", () => {
  it("prefixes the tag under tagged-v1", () => {
    const b = authChallengeSigningBytes(c32, "tagged-v1");
    expect(b.slice(0, 25)).toEqual(utf8("wavvon/auth-challenge/v1\0"));
    expect(b.slice(25)).toEqual(c32);
  });

  it("refuses a missing scheme instead of signing the raw challenge", () => {
    expect(() => authChallengeSigningBytes(c32)).toThrow(AuthSchemeError);
    expect(() => authChallengeSigningBytes(c32, null)).toThrow(AuthSchemeError);
  });

  it("refuses an unknown scheme", () => {
    expect(() => authChallengeSigningBytes(c32, "tagged-v2")).toThrow(AuthSchemeError);
    expect(() => authChallengeSigningBytes(c32, "")).toThrow(AuthSchemeError);
  });

  it("accepts a seed as hex or bytes and rejects other lengths", () => {
    expect(identityFromSeed(seed).publicKey).toBe(identityFromSeed(hexToBytes(seed)).publicKey);
    expect(() => identityFromSeed("abcd")).toThrow(TypeError);
  });
});

/** A hub that answers the challenge flow; `failVerify` counts transient verifies. */
function fakeHub(opts: { scheme?: string; failVerify?: number; verifyStatus?: number } = {}) {
  const challenges: string[] = [];
  const seen: { verify: Record<string, unknown>[] } = { verify: [] };
  let failVerify = opts.failVerify ?? 0;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    if (url.endsWith("/auth/challenge")) {
      const ch = bytesToHex(new Uint8Array(32).fill(challenges.length + 1));
      challenges.push(ch);
      return Response.json(opts.scheme === undefined ? { challenge: ch } : { challenge: ch, scheme: opts.scheme });
    }
    seen.verify.push(body);
    if (failVerify-- > 0) return new Response("busy", { status: 503 });
    if (opts.verifyStatus) return new Response("This hub requires an invite code", { status: opts.verifyStatus });
    const msg = authChallengeSigningBytes(hexToBytes(body.challenge), opts.scheme);
    const okSig = ed25519.verify(hexToBytes(body.signature), msg, hexToBytes(body.public_key));
    if (!okSig) return new Response("Invalid signature", { status: 401 });
    return Response.json({ token: "tok", scope: "member", canonical_pubkey: body.public_key });
  }) as typeof fetch;
  return { fetchImpl, challenges, seen };
}

const fast = { baseDelayMs: 1, maxDelayMs: 1 };

describe("authenticate", () => {
  it("logs in with tagged-v1 and passes the invite", async () => {
    const hub = fakeHub({ scheme: "tagged-v1" });
    const s = await authenticate("http://hub/", identityFromSeed(seed), { fetch: hub.fetchImpl, inviteCode: "inv" });
    expect(s.token).toBe("tok");
    expect(hub.seen.verify[0]!.invite_code).toBe("inv");
  });

  it("restarts from a fresh challenge after a transient verify failure", async () => {
    const hub = fakeHub({ scheme: "tagged-v1", failVerify: 2 });
    await authenticate("http://hub", identityFromSeed(seed), { fetch: hub.fetchImpl, retry: fast });
    expect(hub.challenges.length).toBe(3);
    expect(new Set(hub.seen.verify.map((v) => v.challenge)).size).toBe(3);
  });

  it("surfaces a definitive refusal as HubError", async () => {
    const hub = fakeHub({ scheme: "tagged-v1", verifyStatus: 403 });
    await expect(authenticate("http://hub", identityFromSeed(seed), { fetch: hub.fetchImpl })).rejects.toMatchObject({
      constructor: HubError,
      status: 403,
    });
  });

  it("refuses a hub that names no scheme without calling verify", async () => {
    const hub = fakeHub();
    await expect(authenticate("http://hub", identityFromSeed(seed), { fetch: hub.fetchImpl })).rejects.toBeInstanceOf(
      AuthSchemeError,
    );
    expect(hub.seen.verify.length).toBe(0);
  });

  it("never sends the seed", async () => {
    const hub = fakeHub({ scheme: "tagged-v1" });
    await authenticate("http://hub", identityFromSeed(seed), { fetch: hub.fetchImpl, inviteCode: "x" });
    expect(JSON.stringify(hub.seen)).not.toContain(seed);
  });
});
