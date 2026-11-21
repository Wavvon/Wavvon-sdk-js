// Asserts the tier-1 vectors from Wavvon-server's wire-vectors.json, the one
// authority for every signed byte sequence (sdk.md §4). The file is read, never
// copied in: point WAVVON_WIRE_VECTORS at a pinned copy, or keep the default
// sibling checkout.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import { bytesToHex, hexToBytes, utf8 } from "../src/bytes.js";
import {
  authChallengeSigningBytes,
  dhKeySigningBytes,
  verifyDhKeyRecord,
  voiceKeyUnwrap,
  voiceKeyWrap,
  voicePacketOpen,
  voicePacketSeal,
  identityFromSeed,
  outgoingWebhookSigningKey,
  verifyDispatch,
  verifyOutgoingWebhook,
  webhookDeliverySigningBytes,
} from "../src/index.js";

const path = resolve(process.env.WAVVON_WIRE_VECTORS ?? "../../server/crates/identity/wire-vectors.json");
const present = existsSync(path);

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };
interface VectorFile {
  format: number;
  fixtures: Record<string, string>;
  vectors: Record<string, Record<string, Json>>;
}

/** "@name" anywhere in the file means fixtures[name]. */
function resolveRefs(v: Json, fixtures: Record<string, string>): Json {
  if (typeof v === "string" && v.startsWith("@")) {
    const f = fixtures[v.slice(1)];
    if (f === undefined) throw new Error(`unknown fixture ${v}`);
    return f;
  }
  if (Array.isArray(v)) return v.map((x) => resolveRefs(x, fixtures));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolveRefs(x, fixtures)]));
  return v;
}

if (!present) {
  console.error(
    `\n${"!".repeat(72)}\n!! CONFORMANCE VECTORS NOT FOUND at ${path}\n` +
      `!! The tier-1 wire vectors were NOT checked. Set WAVVON_WIRE_VECTORS.\n${"!".repeat(72)}\n`,
  );
}

describe("conformance vectors file", () => {
  it.runIf(!present && !!process.env.CI)("must be present in CI", () => {
    expect.fail(`wire vectors missing at ${path}`);
  });
});

describe.runIf(present)("tier-1 conformance (wire-vectors.json)", () => {
  const file = present ? (JSON.parse(readFileSync(path, "utf8")) as VectorFile) : undefined;
  const vector = (name: string) => {
    const v = file!.vectors[name];
    if (!v) throw new Error(`vector ${name} missing from ${path}`);
    return resolveRefs(v, file!.fixtures) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  };

  it("speaks format 1", () => {
    expect(file!.format).toBe(1);
  });

  it("auth_challenge: tagged-v1 signing bytes and signature", () => {
    const v = vector("auth_challenge");
    const bytes = authChallengeSigningBytes(hexToBytes(v.inputs.challenge), "tagged-v1");
    expect(bytesToHex(bytes)).toBe(v.signing_bytes);
    expect(bytesToHex(identityFromSeed(v.inputs.signer_seed).sign(bytes))).toBe(v.signature);
  });

  it("bound_auth_challenge: tagged-v2 signing bytes and signature", () => {
    const v = vector("bound_auth_challenge");
    const bytes = authChallengeSigningBytes(hexToBytes(v.inputs.challenge), "tagged-v2", v.inputs.server_pubkey);
    expect(bytesToHex(bytes)).toBe(v.signing_bytes);
    expect(bytesToHex(identityFromSeed(v.inputs.signer_seed).sign(bytes))).toBe(v.signature);
  });

  it("webhook_delivery_hub: Ed25519 dispatch signature verifies", () => {
    const v = vector("webhook_delivery_hub");
    const body = utf8(v.inputs.body);
    const bytes = webhookDeliverySigningBytes(v.inputs.timestamp, body);
    expect(bytesToHex(bytes)).toBe(v.signing_bytes);
    expect(identityFromSeed(v.inputs.hub_seed).publicKey).toBe(v.hub_pubkey);
    expect(bytesToHex(ed25519.sign(bytes, hexToBytes(v.inputs.hub_seed)))).toBe(v.signature_v1);

    const headers = {
      [v.headers.hub_pubkey]: v.hub_pubkey,
      [v.headers.signature_v1]: v.signature_v1,
      [v.headers.timestamp]: String(v.inputs.timestamp),
    };
    expect(verifyDispatch(headers, body, v.hub_pubkey, { now: v.inputs.timestamp }).type).toBe("slash_command");
  });

  it("webhook_delivery_outgoing: HKDF key and HMAC signatures", () => {
    const v = vector("webhook_delivery_outgoing");
    expect(v.inputs.hkdf_salt).toBe("wavvon-webhook-signing");
    expect(v.inputs.hkdf_info).toBe("");
    const key = outgoingWebhookSigningKey(v.inputs.secret_as_shown);
    expect(bytesToHex(key)).toBe(v.signing_key);
    expect(bytesToHex(outgoingWebhookSigningKey(hexToBytes(v.inputs.raw_secret)))).toBe(v.signing_key);

    const body = utf8(v.inputs.body);
    const bytes = webhookDeliverySigningBytes(v.inputs.timestamp, body);
    expect(bytesToHex(bytes)).toBe(v.signing_bytes);
    expect(bytesToHex(hmac(sha256, key, bytes))).toBe(v.signature_v1);

    const headers = {
      [v.headers.signature_v1]: v.signature_v1,
      [v.headers.timestamp]: String(v.inputs.timestamp),
      [v.headers.webhook_id]: "wh_test",
    };
    const event = verifyOutgoingWebhook(headers, body, v.inputs.secret_as_shown, { now: v.inputs.timestamp });
    expect(event.type).toBe("hub_event");
  });

  it("master_dh_pubkey: seed to X25519", () => {
    const v = vector("master_dh_pubkey");
    expect(identityFromSeed(v.inputs.seed).dhPublicKey).toBe(v.dh_pubkey);
  });

  it("dh_key_record: signing bytes, signature, verification", () => {
    const v = vector("dh_key_record");
    const bytes = dhKeySigningBytes(v.inputs.pubkey, v.inputs.dh_pubkey);
    expect(bytesToHex(bytes)).toBe(v.signing_bytes);
    expect(bytesToHex(identityFromSeed(v.inputs.signer_seed).sign(bytes))).toBe(v.signature);
    expect(verifyDhKeyRecord(v.inputs.pubkey, v.inputs.dh_pubkey, v.signature)).toBe(true);
    expect(verifyDhKeyRecord(v.inputs.pubkey, v.inputs.pubkey, v.signature)).toBe(false);
  });

  it("voice_key_wrap: wrap, and unwrap on the recipient side", () => {
    const v = vector("voice_key_wrap");
    const sender = identityFromSeed(v.inputs.sender_seed);
    const recipient = identityFromSeed(v.inputs.recipient_seed);
    const ct = voiceKeyWrap(
      sender.dh!(hexToBytes(recipient.dhPublicKey!)),
      v.inputs.channel_id,
      hexToBytes(v.inputs.sender_key),
      hexToBytes(v.inputs.nonce_salt),
      v.inputs.key_id,
      hexToBytes(v.inputs.wrap_nonce),
    );
    expect(bytesToHex(ct)).toBe(v.ciphertext);
    const k = voiceKeyUnwrap(
      recipient.dh!(hexToBytes(sender.dhPublicKey!)),
      v.inputs.channel_id,
      hexToBytes(v.ciphertext),
      hexToBytes(v.inputs.wrap_nonce),
    );
    expect(bytesToHex(k.senderKey)).toBe(v.inputs.sender_key);
    expect(bytesToHex(k.nonceSalt)).toBe(v.inputs.nonce_salt);
    expect(k.keyId).toBe(v.inputs.key_id);
  });

  it.each(["voice_packet_ctr0", "voice_packet_ctr7"])("%s: seal and open", (name) => {
    const v = vector(name);
    const key = hexToBytes(v.inputs.sender_key);
    const salt = hexToBytes(v.inputs.nonce_salt);
    const sealed = voicePacketSeal(key, salt, v.inputs.key_id, BigInt(v.inputs.counter), v.inputs.timestamp, hexToBytes(v.inputs.opus));
    expect(bytesToHex(sealed)).toBe(v.packet);
    const opened = voicePacketOpen(key, salt, hexToBytes(v.packet));
    expect(opened).toEqual({ keyId: v.inputs.key_id, ctr: BigInt(v.inputs.counter), ts: v.inputs.timestamp, opus: hexToBytes(v.inputs.opus) });
    const tampered = hexToBytes(v.packet);
    tampered[tampered.length - 1]! ^= 1;
    expect(() => voicePacketOpen(key, salt, tampered)).toThrow();
  });
});
