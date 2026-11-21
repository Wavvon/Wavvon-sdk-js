import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex, concatBytes, hexToBytes, utf8 } from "./bytes.js";
import type { WavvonClient } from "./client.js";
import { DhKeyChangedError, DhKeyUnsignedError, HubError, RecipientHasNoKeyError } from "./errors.js";

/**
 * Where pinned peer DH keys live (trust on first use). A `Map` is the
 * in-memory default; a program that wants pins across restarts passes its own.
 */
export interface DhPinStore {
  get(key: string): string | undefined | Promise<string | undefined>;
  set(key: string, value: string): unknown;
}

function lenPrefixed(s: string): Uint8Array {
  const b = utf8(s);
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, b.length, true);
  return concatBytes(len, b);
}

/** What `pubkey` signs to publish its DH key (wire-format.md, DhKeyRecord). */
export function dhKeySigningBytes(pubkey: string, dhPubkeyHex: string): Uint8Array {
  return concatBytes(utf8("wavvon/dh-key/v1\0"), lenPrefixed(pubkey), lenPrefixed(dhPubkeyHex));
}

export function verifyDhKeyRecord(pubkey: string, dhPubkeyHex: string, signatureHex: string): boolean {
  try {
    return ed25519.verify(hexToBytes(signatureHex), dhKeySigningBytes(pubkey, dhPubkeyHex), hexToBytes(pubkey));
  } catch {
    return false;
  }
}

/**
 * The DH key `pubkey` published, verified against its signature; `undefined`
 * on a 404 or a record without a key. A record `pubkey` did not sign throws:
 * the hub is not trusted with it.
 */
export async function fetchDhRecord(client: WavvonClient, pubkey: string): Promise<string | undefined> {
  const res = await client.rest.GET("/identity/{pubkey}/dh-key", { params: { path: { pubkey } } });
  if (res.response.status === 404) return undefined;
  if (!res.response.ok) throw new HubError(res.response.status, JSON.stringify(res.error ?? ""));
  const rec = (res.data ?? {}) as { dh_pubkey_hex?: string | null; signature_hex?: string | null };
  if (!rec.dh_pubkey_hex) return undefined;
  if (!rec.signature_hex || !verifyDhKeyRecord(pubkey, rec.dh_pubkey_hex, rec.signature_hex)) {
    throw new DhKeyUnsignedError(pubkey);
  }
  return rec.dh_pubkey_hex;
}

export async function publishDhKey(client: WavvonClient): Promise<boolean> {
  const own = client.identity.publicKey;
  const dh = client.identity.dhPublicKey;
  if (!dh) throw new TypeError("this Identity has no DH key; build it with identityFromSeed");
  try {
    if ((await fetchDhRecord(client, own)) === dh) return false;
  } catch (e) {
    if (!(e instanceof DhKeyUnsignedError)) throw e;
  }
  const signature = client.identity.sign(dhKeySigningBytes(own, dh));
  const res = await client.rest.PUT("/identity/{pubkey}/dh-key", {
    params: { path: { pubkey: own } },
    body: { dh_pubkey_hex: dh, signature_hex: bytesToHex(signature) },
  });
  if (!res.response.ok) throw new HubError(res.response.status, JSON.stringify(res.error ?? ""));
  return true;
}

export async function peerDhKey(client: WavvonClient, pins: DhPinStore, pubkey: string): Promise<Uint8Array> {
  const dh = await fetchDhRecord(client, pubkey);
  if (!dh) throw new RecipientHasNoKeyError(pubkey);
  const raw = hexToBytes(dh);
  if (raw.length !== 32) throw new DhKeyUnsignedError(pubkey);
  const key = `dh-pin/${pubkey}`;
  const pinned = await pins.get(key);
  if (pinned === undefined) await pins.set(key, dh);
  else if (pinned !== dh) throw new DhKeyChangedError(pubkey, pinned, dh);
  return raw;
}

export async function acceptDhKey(client: WavvonClient, pins: DhPinStore, pubkey: string): Promise<void> {
  const dh = await fetchDhRecord(client, pubkey);
  if (!dh) throw new RecipientHasNoKeyError(pubkey);
  await pins.set(`dh-pin/${pubkey}`, dh);
}
