import { ed25519 } from "@noble/curves/ed25519.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import { bytesToHex, utf8 } from "../src/bytes.js";
import {
  WebhookVerificationError,
  createDispatchHandler,
  outgoingWebhookSigningKey,
  verifyDispatch,
  verifyOutgoingWebhook,
  webhookDeliverySigningBytes,
} from "../src/index.js";

const hubSeed = new Uint8Array(32).fill(5);
const hubPub = bytesToHex(ed25519.getPublicKey(hubSeed));
const now = 1_700_000_000;

function signedDispatch(body: string, ts = now) {
  const sig = ed25519.sign(webhookDeliverySigningBytes(ts, utf8(body)), hubSeed);
  return {
    "X-Wavvon-Hub-Pubkey": hubPub,
    "X-Wavvon-Signature-V1": bytesToHex(sig),
    "X-Wavvon-Timestamp": String(ts),
  };
}

const slash = JSON.stringify({
  type: "slash_command",
  hub_url: "https://h",
  channel_id: "c",
  message_id_hint: "m",
  author: { pubkey: "p" },
  command: "echo",
  args_raw: "hi there",
  args_tokens: ["hi", "there"],
});

describe("verifyDispatch", () => {
  it("accepts a correctly signed invocation and decodes it", () => {
    const inv = verifyDispatch(signedDispatch(slash), slash, hubPub, { now });
    expect(inv).toMatchObject({ type: "slash_command", command: "echo" });
  });

  it("refuses a tampered body, a stale timestamp, a missing V1 header and a foreign hub", () => {
    const h = signedDispatch(slash);
    expect(() => verifyDispatch(h, slash.replace("echo", "ban"), hubPub, { now })).toThrow(WebhookVerificationError);
    expect(() => verifyDispatch(h, slash, hubPub, { now: now + 301 })).toThrow(WebhookVerificationError);
    expect(verifyDispatch(h, slash, hubPub, { now: now + 300 }).type).toBe("slash_command");
    const legacyOnly: Record<string, string> = { ...h };
    delete legacyOnly["X-Wavvon-Signature-V1"];
    expect(() => verifyDispatch(legacyOnly, slash, hubPub, { now })).toThrow(WebhookVerificationError);
    const other = bytesToHex(ed25519.getPublicKey(new Uint8Array(32).fill(6)));
    expect(() => verifyDispatch(h, slash, other, { now })).toThrow(WebhookVerificationError);
  });

  it("delivers an unknown dispatch type instead of dropping it", () => {
    const body = JSON.stringify({ type: "modal_submit", x: 1 });
    expect(verifyDispatch(signedDispatch(body), body, hubPub, { now })).toMatchObject({
      type: "unknown",
      rawType: "modal_submit",
    });
  });
});

describe("createDispatchHandler", () => {
  const handler = createDispatchHandler({
    hubPublicKey: hubPub,
    now,
    onSlashCommand: (inv) => ({ reply: { body: inv.args_raw }, ephemeral: true }),
  });

  it("answers a verified invocation with the reply", async () => {
    const res = await handler(new Request("http://app/hook", { method: "POST", headers: signedDispatch(slash), body: slash }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reply: { body: "hi there" }, ephemeral: true });
  });

  it("answers 401 to an unverified one", async () => {
    const res = await handler(new Request("http://app/hook", { method: "POST", body: slash }));
    expect(res.status).toBe(401);
  });
});

describe("verifyOutgoingWebhook", () => {
  const secret = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";
  const body = JSON.stringify({ type: "hub_event", seq: 3, event: "member.joined", hub_url: "h", at: now, payload: {} });
  const sig = bytesToHex(hmac(sha256, outgoingWebhookSigningKey(secret), webhookDeliverySigningBytes(now, utf8(body))));
  const headers = { "x-wavvon-signature-v1": sig, "x-wavvon-timestamp": String(now) };

  it("accepts the secret as shown and as decoded bytes", () => {
    expect(verifyOutgoingWebhook(headers, body, secret, { now }).seq).toBe(3);
    expect(verifyOutgoingWebhook(new Headers(headers), body, new Uint8Array(32).fill(7), { now }).seq).toBe(3);
  });

  it("refuses the wrong secret or a replay outside the window", () => {
    expect(() => verifyOutgoingWebhook(headers, body, "AAAA", { now })).toThrow(WebhookVerificationError);
    expect(() => verifyOutgoingWebhook(headers, body, secret, { now: now - 400 })).toThrow(WebhookVerificationError);
  });
});
