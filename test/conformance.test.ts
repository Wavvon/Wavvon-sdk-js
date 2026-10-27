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
});
