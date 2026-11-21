// A program in a voice channel (sdk-voice.md). It does what the desktop and
// web clients do: signalling rides a WebSocket of the room's own, the audio a
// WebRTC data channel, and every packet is sealed with a per-sender key
// wrapped to each listener's DH key.
//
// The SDK owns the mechanisms (key distribution and rotation, 20 ms pacing,
// the replay watermark, the proximity rate limit). It decides nothing for the
// program: mute, deafen, AFK moves and a changed DH key are events and calls.

import { gcm } from "@noble/ciphers/aes.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes, utf8 } from "./bytes.js";
import type { WavvonClient } from "./client.js";
import { peerDhKey, publishDhKey, type DhPinStore } from "./dh.js";
import { DhKeyChangedError, DhKeyUnsignedError, RecipientHasNoKeyError, VoiceError } from "./errors.js";
import type { ClientMessage, EventStream, WsEvent } from "./events.js";
import { MAX_PACKET, createOffer, type Link } from "./voiceTransport.js";

// ---------------------------------------------------------------------------
// Crypto (wire-format.md, "Voice key wrap" and "Voice packet seal")
// ---------------------------------------------------------------------------

const VOICE_KEY_INFO = utf8("wavvon/voice-key/v1");
const HEADER_LEN = 16;

function u32be(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, false);
  return b;
}

function u64be(n: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, false);
  return b;
}

const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

function wrapKey(sharedSecret: Uint8Array, channelId: string): Uint8Array {
  return hkdf(sha256, sharedSecret, utf8(channelId), VOICE_KEY_INFO, 32);
}

/** `sharedSecret` is X25519(own DH secret, recipient DH public key): `identity.dh(peer)`. */
export function voiceKeyWrap(
  sharedSecret: Uint8Array,
  channelId: string,
  senderKey: Uint8Array,
  nonceSalt: Uint8Array,
  keyId: number,
  nonce: Uint8Array,
): Uint8Array {
  return gcm(wrapKey(sharedSecret, channelId), nonce).encrypt(concatBytes(senderKey, nonceSalt, u32be(keyId)));
}

export function voiceKeyUnwrap(
  sharedSecret: Uint8Array,
  channelId: string,
  ciphertext: Uint8Array,
  nonce: Uint8Array,
): { senderKey: Uint8Array; nonceSalt: Uint8Array; keyId: number } {
  const p = gcm(wrapKey(sharedSecret, channelId), nonce).decrypt(ciphertext);
  if (p.length !== 40) throw new Error(`wrapped voice key is ${p.length} bytes, not 40`);
  return { senderKey: p.slice(0, 32), nonceSalt: p.slice(32, 36), keyId: view(p).getUint32(36, false) };
}

/** `key_id[4] || ctr[8] || ts[4]` in clear (and as AAD), then AES-256-GCM(opus). */
export function voicePacketSeal(
  senderKey: Uint8Array,
  nonceSalt: Uint8Array,
  keyId: number,
  ctr: bigint,
  ts: number,
  opus: Uint8Array,
): Uint8Array {
  const header = concatBytes(u32be(keyId), u64be(ctr), u32be(ts));
  return concatBytes(header, gcm(senderKey, concatBytes(nonceSalt, u64be(ctr)), header).encrypt(opus));
}

export function voicePacketOpen(
  senderKey: Uint8Array,
  nonceSalt: Uint8Array,
  packet: Uint8Array,
): { keyId: number; ctr: bigint; ts: number; opus: Uint8Array } {
  if (packet.length < HEADER_LEN + 16) throw new Error(`voice packet too short: ${packet.length} bytes`);
  const header = packet.subarray(0, HEADER_LEN);
  const v = view(header);
  const nonce = concatBytes(nonceSalt, header.subarray(4, 12));
  const opus = gcm(senderKey, nonce, header).decrypt(packet.subarray(HEADER_LEN));
  return { keyId: v.getUint32(0, false), ctr: v.getBigUint64(4, false), ts: v.getUint32(12, false), opus };
}

/**
 * Duration of an Opus packet in microseconds, from its TOC byte (RFC 6716
 * 3.1). The SDK sends only 20 ms packets: the desktop decoder's output buffer
 * holds 20 ms, so a 40 or 60 ms packet fails to decode on every desktop listener.
 */
export function opusDurationUs(packet: Uint8Array): number {
  const toc = packet[0];
  if (toc === undefined) throw new Error("empty packet");
  const config = toc >> 3;
  const frameUs =
    config <= 11 ? [10_000, 20_000, 40_000, 60_000][config % 4]! : config <= 15 ? [10_000, 20_000][config % 2]! : [2_500, 5_000, 10_000, 20_000][config % 4]!;
  let frames: number;
  if ((toc & 3) === 0) frames = 1;
  else if ((toc & 3) !== 3) frames = 2;
  else {
    const n = packet[1];
    if (n === undefined) throw new Error("code-3 packet without a frame count");
    frames = n & 0x3f;
  }
  if (frames === 0) throw new Error("packet declares zero frames");
  return frameUs * frames;
}

// ---------------------------------------------------------------------------
// The room
// ---------------------------------------------------------------------------

const FRAME_MS = 20;
const FRAME_SAMPLES = 960;
/** A program this far behind is re-anchored instead of bursting to catch up. */
const MAX_LAG_FRAMES = 3;
/** More than one position every 50 ms risks the hub's silent 30 ms rate drop. */
const POSITION_EVERY_MS = 50;
const SPEAKING_IDLE_MS = 200;
const STEP_TIMEOUT_MS = 15_000;

export interface Participant {
  publicKey: string;
  senderId: number;
  displayName?: string;
}

export interface Zone {
  zoneId: string;
  name: string;
  /** `"2d"` or `"3d"`. */
  coordinateSystem: string;
  attenuation: unknown;
  positions: Record<string, number[]>;
}

/** One decrypted 20 ms packet from one speaker. Jitter buffering is the program's: order by `ts` and `ctr`. */
export interface AudioFrame {
  from: string;
  senderId: number;
  keyId: number;
  /** 48 kHz sample clock, +960 per frame. */
  ts: number;
  ctr: bigint;
  whisper: boolean;
  opus: Uint8Array;
}

export type VoiceEvent =
  | ({ type: "audio" } & AudioFrame)
  /** Who is in the room, after any change. */
  | { type: "roster"; participants: Participant[] }
  | { type: "speaking"; publicKey: string; speaking: boolean }
  /** The room's zones, after any change. */
  | { type: "zones"; zones: Zone[] }
  | { type: "position"; zoneId: string; publicKey: string; position: number[] }
  /** The hub refused a position (unknown zone, or someone else's creator-only zone). */
  | { type: "position_refused"; reason: string }
  /** A moderator gave this program the floor; `maySpeak` is now true. */
  | { type: "talk_granted" }
  /** A moderator, or the AFK sweep (`auto`), asks the program to move. The hub moves no one. */
  | {
      type: "move_requested";
      targetChannelId: string;
      targetChannelName: string;
      sourceChannelId?: string;
      eventId?: string;
      auto: boolean;
    }
  /** The socket dropped, which ended the room on the hub; the SDK is joining again with a fresh key. */
  | { type: "rejoining" }
  /** A participant could not be given this program's key (no DH key, or a changed one), so it cannot hear it. */
  | { type: "key_skipped"; publicKey: string; reason: string }
  /** A `voice_*` message this SDK does not model. */
  | { type: "unknown"; raw: unknown }
  | { type: "error"; error: Error };

/** An unbounded queue with an awaitable head. `undefined` means closed. */
class Queue<T> {
  private items: T[] = [];
  private waiters: ((v: T | undefined) => void)[] = [];
  private closed = false;

  push(v: T): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w(v);
    else this.items.push(v);
  }

  close(): void {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w(undefined);
  }

  next(timeoutMs?: number): Promise<T | undefined> {
    if (this.items.length) return Promise.resolve(this.items.shift());
    if (this.closed) return Promise.resolve(undefined);
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const w = (v: T | undefined) => {
        clearTimeout(timer);
        resolve(v);
      };
      this.waiters.push(w);
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          this.waiters = this.waiters.filter((x) => x !== w);
          reject(new VoiceError("transport", "timed out waiting for the hub"));
        }, timeoutMs);
      }
    });
  }
}

interface Raw {
  [k: string]: unknown;
}
const str = (r: Raw, k: string): string => (typeof r[k] === "string" ? (r[k] as string) : "");
const u16 = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 0xffff ? v : undefined;
const numbers = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : []);

function participant(v: unknown): Participant | undefined {
  const r = (v ?? {}) as Raw;
  const senderId = u16(r.sender_id);
  if (typeof r.public_key !== "string" || senderId === undefined) return undefined;
  return { publicKey: r.public_key, senderId, displayName: typeof r.display_name === "string" ? r.display_name : undefined };
}

function zone(v: unknown): Zone | undefined {
  const r = (v ?? {}) as Raw;
  if (typeof r.zone_id !== "string") return undefined;
  const positions: Record<string, number[]> = {};
  for (const [k, p] of Object.entries((r.positions ?? {}) as Raw)) positions[k] = numbers(p);
  return { zoneId: r.zone_id, name: str(r, "name"), coordinateSystem: str(r, "coordinate_system"), attenuation: r.attenuation, positions };
}

const isPerPeer = (e: unknown) =>
  e instanceof RecipientHasNoKeyError || e instanceof DhKeyChangedError || e instanceof DhKeyUnsignedError;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Publishes the DH key, joins the channel's voice room and opens the audio
 * session. One room per client: the hub allows one per identity.
 */
export async function joinVoice(client: WavvonClient, channelId: string, pins: DhPinStore): Promise<Voice> {
  await client.requireCapability("channels.voice");
  // Voice transport v3: a hub without it speaks only WebTransport.
  await client.requireCapability("voice.webrtc");
  if (!client.identity.dh) throw new TypeError("this Identity has no DH key; build it with identityFromSeed");
  // Without a published key nobody wraps a voice key to this program and it
  // cannot unwrap theirs: it would be deaf and mute.
  await publishDhKey(client);
  // A socket of its own: the hub ties the room to the connection.
  const voice = new Voice(client, client.connect(), channelId, pins);
  try {
    await voice.start();
  } catch (e) {
    voice.shutdown();
    throw e;
  }
  return voice;
}

/** A joined voice room. Read events with `next()` or `for await`; send from anywhere. */
export class Voice implements AsyncIterable<VoiceEvent> {
  private readonly me: string;
  private readonly inbox = new Queue<WsEvent>();
  private readonly out = new Queue<VoiceEvent>();
  private readonly dhCache = new Map<string, Uint8Array>();
  private _channelId: string;
  private _senderId = 0;
  private inRoom = false;
  private _maySpeak = true;
  private muted = false;
  private deafened = false;
  private rosterMap = new Map<number, Participant>();
  private own = { key: new Uint8Array(32), salt: new Uint8Array(4), keyId: 0, ctr: 0n };
  private remote = new Map<string, { key: Uint8Array; salt: Uint8Array }>();
  private marks = new Map<string, bigint>();
  private zoneList: Zone[] = [];
  private link: Link | undefined;
  private pacing: { next: number; ts: number } | undefined;
  private speaking = false;
  private lastSend = 0;
  private position: { zoneId: string; position: number[] } | undefined;
  private lastPosition = -Infinity;
  private tick: ReturnType<typeof setInterval> | undefined;
  private stopped = false;

  /** @internal use `client.joinVoice`. */
  constructor(
    private readonly client: WavvonClient,
    private readonly stream: EventStream,
    channelId: string,
    private readonly pins: DhPinStore,
  ) {
    this.me = client.identity.publicKey;
    this._channelId = channelId;
    stream.on("*", (ev) => this.inbox.push(ev));
  }

  /** @internal */
  async start(): Promise<void> {
    for (;;) {
      const ev = await this.inbox.next(STEP_TIMEOUT_MS);
      if (!ev) throw new VoiceError("transport", "socket closed");
      if (ev.type === "hello") break;
    }
    await this.establish(this._channelId);
    this.tick = setInterval(() => this.housekeeping(), 25);
    void this.loop();
  }

  /** @internal */
  shutdown(): void {
    this.stopped = true;
    clearInterval(this.tick);
    this.link?.close();
    this.link = undefined;
    this.stream.close();
    this.inbox.close();
    this.out.close();
  }

  /** The next thing that happened in the room; `undefined` after `leave`. */
  next(): Promise<VoiceEvent | undefined> {
    return this.out.next();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<VoiceEvent> {
    for (;;) {
      const ev = await this.out.next();
      if (!ev) return;
      yield ev;
    }
  }

  get channelId(): string {
    return this._channelId;
  }

  /** This program's relay id in the room. */
  get senderId(): number {
    return this._senderId;
  }

  roster(): Participant[] {
    return [...this.rosterMap.values()].sort((a, b) => a.senderId - b.senderId);
  }

  zones(): Zone[] {
    return [...this.zoneList];
  }

  /** False means the relay drops what this program sends; `sendOpus` then throws `may_not_speak`. */
  get maySpeak(): boolean {
    return this._maySpeak;
  }

  /** Local: the hub has no self-mute. Stops sending (calls still wait their slot) and ends the speaking indication. */
  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted && this.speaking) {
      this.speaking = false;
      this.trySend({ type: "voice_speaking", channel_id: this._channelId, speaking: false });
    }
  }

  /** Local: stops delivering audio. Key distribution keeps running, so undeafening is instant. */
  setDeafened(deafened: boolean): void {
    this.deafened = deafened;
  }

  /**
   * One 20 ms Opus packet, held until its slot on a monotonic clock. A source
   * faster than real time is slowed to it; one more than three frames behind
   * is re-anchored, `ts` jumping by the slots it missed.
   */
  async sendOpus(packet: Uint8Array): Promise<void> {
    let us: number;
    try {
      us = opusDurationUs(packet);
    } catch (e) {
      throw new VoiceError("bad_frame", (e as Error).message);
    }
    if (us !== 20_000) throw new VoiceError("bad_frame", `${us / 1000} ms, not 20 ms`);
    if (!this.inRoom) throw new VoiceError("not_in_room", "not in a voice room");
    if (!this._maySpeak) throw new VoiceError("may_not_speak", "this program may not speak in this room");
    // The hub adds the 3-byte relay prefix on the way out.
    if (HEADER_LEN + packet.length + 16 + 3 > MAX_PACKET) {
      throw new VoiceError("packet_too_large", `a ${packet.length}-byte packet does not fit one SCTP chunk`);
    }
    const now = performance.now();
    const p = (this.pacing ??= { next: now, ts: 0 });
    if (now > p.next + FRAME_MS * MAX_LAG_FRAMES) {
      const missed = Math.floor((now - p.next) / FRAME_MS);
      p.ts = (p.ts + FRAME_SAMPLES * missed) >>> 0;
      p.next = now;
    }
    const slot = p.next;
    const ts = p.ts;
    p.next += FRAME_MS;
    p.ts = (p.ts + FRAME_SAMPLES) >>> 0;
    const wait = slot - performance.now();
    if (wait > 0) await sleep(wait);

    if (!this.inRoom || !this.link) throw new VoiceError("not_in_room", "not in a voice room");
    if (this.muted) return;
    const { key, salt, keyId, ctr } = this.own;
    this.own.ctr++;
    const started = !this.speaking;
    this.speaking = true;
    this.lastSend = performance.now();
    const sealed = voicePacketSeal(key, salt, keyId, ctr, ts, packet);
    if (started) this.stream.send({ type: "voice_speaking", channel_id: this._channelId, speaking: true });
    this.link.send(sealed);
  }

  /**
   * Latest position in a zone of this room. At most one reaches the hub every
   * 50 ms (it silently drops one under 30 ms after the last); the newest is
   * always the one sent. Checked here, because the hub drops a bad one silently.
   */
  setPosition(zoneId: string, position: number[]): void {
    const z = this.zoneList.find((x) => x.zoneId === zoneId);
    if (!z) throw new VoiceError("unknown_zone", `no zone ${zoneId} in this room`);
    const want =
      z.coordinateSystem === "2d" ? 2 : z.coordinateSystem === "3d" ? 3 : Math.min(3, Math.max(1, position.length));
    if (position.length !== want) {
      throw new VoiceError("bad_position", `${position.length} coordinates, the zone wants ${want}`);
    }
    this.position = { zoneId, position: [...position] };
  }

  /**
   * Needs `channels.manage` on the channel. `attenuation` is the hub's
   * `{model, max_radius, ref_dist, rolloff}` object; `{}` takes the defaults.
   */
  createZone(
    zoneId: string,
    name: string,
    coordinateSystem: "2d" | "3d",
    attenuation: Record<string, unknown> = {},
    authMode: "creator_only" | "any_channel_member" = "any_channel_member",
  ): void {
    this.stream.send({
      type: "voice_zone_create",
      zone_id: zoneId,
      name,
      coordinate_system: coordinateSystem,
      attenuation,
      auth_mode: authMode,
    });
  }

  destroyZone(zoneId: string): void {
    this.stream.send({ type: "voice_zone_destroy", zone_id: zoneId });
  }

  /** `voice_leave`, then the audio session closes. Closing the session alone would not leave the roster. */
  async leave(): Promise<void> {
    if (this.stopped) return;
    this.inRoom = false;
    if (this.speaking) this.trySend({ type: "voice_speaking", channel_id: this._channelId, speaking: false });
    this.trySend({ type: "voice_leave", channel_id: this._channelId });
    this.link?.close();
    this.link = undefined;
    // Lets the hub read voice_leave before the socket closes.
    await sleep(100);
    this.shutdown();
  }

  // ---- internals ----

  private emit(ev: VoiceEvent) {
    this.out.push(ev);
  }

  private fail(e: unknown) {
    this.emit({ type: "error", error: e instanceof Error ? e : new Error(String(e)) });
  }

  private trySend(m: ClientMessage) {
    try {
      this.stream.send(m);
    } catch (e) {
      this.fail(e);
    }
  }

  private async loop() {
    while (!this.stopped) {
      const ev = await this.inbox.next();
      if (!ev) return;
      // A second hello: the socket dropped and came back, and the hub already
      // ran leave_voice. The old session is dead; join again.
      if (ev.type === "hello") await this.rejoin();
      else this.handleEvent(ev);
    }
  }

  private async rejoin() {
    this.inRoom = false;
    this.link?.close();
    this.link = undefined;
    this.emit({ type: "rejoining" });
    try {
      await this.establish(this._channelId);
    } catch (e) {
      this.fail(e);
    }
  }

  /** `voice_join` to an open session: joined, audio connected, key offered. */
  private async establish(channelId: string) {
    this.stream.send({ type: "voice_join", channel_id: channelId });
    let joined: Raw;
    for (;;) {
      const ev = await this.inbox.next(STEP_TIMEOUT_MS);
      if (!ev) throw new VoiceError("transport", "socket closed");
      if (ev.type === "unknown" && ev.rawType === "voice_joined") {
        joined = ev.raw as Raw;
        break;
      }
      if (ev.type === "error" && ev.context === "voice_join") throw new VoiceError("refused", ev.message);
    }

    const offer = await createOffer();
    // What arrives while the answer is awaited is kept, a key bundle above
    // all: dropping it would leave this room unable to open that speaker.
    const deferred: WsEvent[] = [];
    let answer: string;
    try {
      this.stream.send({ type: "voice_rtc_offer", token: str(joined, "voice_token"), sdp: offer.sdp });
      for (;;) {
        const ev = await this.inbox.next(STEP_TIMEOUT_MS);
        if (!ev) throw new VoiceError("transport", "socket closed");
        if (ev.type === "unknown" && ev.rawType === "voice_rtc_answer") {
          answer = str(ev.raw as Raw, "sdp");
          break;
        }
        if (ev.type === "error" && ev.context === "voice_rtc_offer") throw new VoiceError("refused", ev.message);
        deferred.push(ev);
      }
    } catch (e) {
      offer.close();
      throw e;
    }
    const link: Link = await offer.accept(answer, {
      onMessage: (p) => this.onDatagram(p),
      onClose: () => {
        if (this.link !== link) return;
        this.link = undefined;
        // After leave or during a rejoin the close is ours.
        if (this.inRoom) this.fail(new VoiceError("transport", "voice data channel closed"));
      },
    });

    const participants = Array.isArray(joined.participants)
      ? joined.participants.map(participant).filter((p): p is Participant => !!p)
      : [];
    const senderId = u16(joined.sender_id);
    if (senderId === undefined) {
      link.close();
      throw new VoiceError("transport", "voice_joined carries no valid sender_id");
    }
    this._channelId = str(joined, "channel_id") || channelId;
    this._senderId = senderId;
    // The key id never goes back: a rejoin must not reuse a (sender, key_id)
    // pair whose replay watermark listeners still hold.
    this.own = { key: randomBytes(32), salt: randomBytes(4), keyId: this.own.keyId + 1, ctr: 0n };
    // A hub without `voice.talk` omits the field; absence is not "muted".
    this._maySpeak = joined.may_speak !== false;
    this.rosterMap = new Map(participants.map((p) => [p.senderId, p]));
    this.remote.clear();
    this.marks.clear();
    this.pacing = undefined;
    this.speaking = false;
    this.link = link;
    this.inRoom = true;
    void this.offerTo(participants.map((p) => p.publicKey).filter((k) => k !== this.me));
    for (const ev of deferred) this.handleEvent(ev);
  }

  /** A peer's DH key, looked up once per room: it is pinned, so a second answer would be the same or a refusal. */
  private async dhFor(pubkey: string): Promise<Uint8Array> {
    let k = this.dhCache.get(pubkey);
    if (!k) {
      k = await peerDhKey(this.client, this.pins, pubkey);
      this.dhCache.set(pubkey, k);
    }
    return k;
  }

  /** Wraps the current sender key to each of `to` and sends one offer. A peer without a usable DH key is skipped and reported. */
  private async offerTo(to: string[]) {
    if (!to.length) return;
    const channel = this._channelId;
    const { key, salt, keyId } = this.own;
    const bundles: { recipient_pubkey: string; ciphertext_hex: string; nonce_hex: string }[] = [];
    for (const pubkey of to) {
      let dh: Uint8Array;
      try {
        dh = await this.dhFor(pubkey);
      } catch (e) {
        if (isPerPeer(e)) {
          this.emit({ type: "key_skipped", publicKey: pubkey, reason: (e as Error).message });
          continue;
        }
        this.fail(e);
        return;
      }
      const nonce = randomBytes(12);
      const ct = voiceKeyWrap(this.client.identity.dh!(dh), channel, key, salt, keyId, nonce);
      bundles.push({ recipient_pubkey: pubkey, ciphertext_hex: bytesToHex(ct), nonce_hex: bytesToHex(nonce) });
    }
    if (bundles.length && !this.stopped) this.trySend({ type: "voice_key_offer", channel_id: channel, bundles });
  }

  private async unwrap(raw: Raw) {
    const from = str(raw, "from_pubkey");
    const channel = this._channelId;
    let ct: Uint8Array, nonce: Uint8Array;
    try {
      ct = hexToBytes(str(raw, "ciphertext_hex"));
      nonce = hexToBytes(str(raw, "nonce_hex"));
    } catch {
      return;
    }
    if (nonce.length !== 12) return;
    let dh: Uint8Array;
    try {
      dh = await this.dhFor(from);
    } catch (e) {
      if (isPerPeer(e)) this.emit({ type: "key_skipped", publicKey: from, reason: (e as Error).message });
      else this.fail(e);
      return;
    }
    let k: ReturnType<typeof voiceKeyUnwrap>;
    try {
      k = voiceKeyUnwrap(this.client.identity.dh!(dh), channel, ct, nonce);
    } catch {
      // A bundle that does not open is dropped: there is no key to use.
      return;
    }
    // A new key for this pair restarts its counter.
    for (const p of this.rosterMap.values()) if (p.publicKey === from) this.marks.delete(`${p.senderId}/${k.keyId}`);
    this.remote.set(`${from}/${k.keyId}`, { key: k.senderKey, salt: k.nonceSalt });
  }

  private rotate() {
    this.own = { key: randomBytes(32), salt: randomBytes(4), keyId: this.own.keyId + 1, ctr: 0n };
  }

  private handleEvent(ev: WsEvent) {
    if (ev.type === "error") {
      if (ev.context === "voice_position_update") this.emit({ type: "position_refused", reason: ev.message });
      else if (ev.context.startsWith("voice")) this.fail(new VoiceError("refused", `${ev.context}: ${ev.message}`));
      return;
    }
    if (ev.type !== "unknown" || !ev.rawType.startsWith("voice_")) return;
    const raw = ev.raw as Raw;
    // Messages about another room are not this session's.
    if (typeof raw.channel_id === "string" && raw.channel_id !== this._channelId) return;
    switch (ev.rawType) {
      case "voice_participant_joined": {
        const p = participant(raw.participant);
        if (p) {
          this.rosterMap.set(p.senderId, p);
          this.emit({ type: "roster", participants: this.roster() });
        }
        break;
      }
      case "voice_participant_left": {
        const left = str(raw, "public_key");
        for (const p of [...this.rosterMap.values()]) {
          if (p.publicKey !== left) continue;
          this.rosterMap.delete(p.senderId);
          for (const m of [...this.marks.keys()]) if (m.startsWith(`${p.senderId}/`)) this.marks.delete(m);
        }
        for (const r of [...this.remote.keys()]) if (r.startsWith(`${left}/`)) this.remote.delete(r);
        // Whoever left kept the key: a new one for the rest.
        this.rotate();
        this.emit({ type: "roster", participants: this.roster() });
        void this.offerTo(this.roster().map((p) => p.publicKey).filter((k) => k !== this.me));
        break;
      }
      case "voice_roster_update": {
        const list = Array.isArray(raw.participants) ? raw.participants.map(participant) : [];
        this.rosterMap = new Map(list.filter((p): p is Participant => !!p).map((p) => [p.senderId, p]));
        this.emit({ type: "roster", participants: this.roster() });
        break;
      }
      case "voice_participant_speaking":
        this.emit({ type: "speaking", publicKey: str(raw, "public_key"), speaking: raw.speaking === true });
        break;
      case "voice_key_request": {
        const newcomer = str(raw, "new_pubkey");
        const id = u16(raw.new_sender_id);
        if (id !== undefined && !this.rosterMap.has(id)) this.rosterMap.set(id, { publicKey: newcomer, senderId: id });
        if (newcomer !== this.me) void this.offerTo([newcomer]);
        break;
      }
      case "voice_key_received": {
        const id = u16(raw.from_sender_id);
        if (id !== undefined && !this.rosterMap.has(id)) {
          this.rosterMap.set(id, { publicKey: str(raw, "from_pubkey"), senderId: id });
        }
        void this.unwrap(raw);
        break;
      }
      case "voice_talk_granted":
        if (str(raw, "public_key") === this.me) {
          this._maySpeak = true;
          this.emit({ type: "talk_granted" });
        }
        break;
      case "voice_move":
        this.emit({
          type: "move_requested",
          targetChannelId: str(raw, "target_channel_id"),
          targetChannelName: str(raw, "target_channel_name"),
          sourceChannelId: typeof raw.source_channel_id === "string" ? raw.source_channel_id : undefined,
          eventId: typeof raw.event_id === "string" ? raw.event_id : undefined,
          auto: raw.auto === true,
        });
        break;
      case "voice_zone_state":
        this.zoneList = Array.isArray(raw.zones) ? raw.zones.map(zone).filter((z): z is Zone => !!z) : [];
        this.emit({ type: "zones", zones: this.zones() });
        break;
      case "voice_zone_created": {
        const z = zone(raw);
        if (z) {
          this.zoneList = [...this.zoneList.filter((x) => x.zoneId !== z.zoneId), z];
          this.emit({ type: "zones", zones: this.zones() });
        }
        break;
      }
      case "voice_zone_destroyed":
        this.zoneList = this.zoneList.filter((z) => z.zoneId !== str(raw, "zone_id"));
        this.emit({ type: "zones", zones: this.zones() });
        break;
      case "voice_position_updated": {
        const zoneId = str(raw, "zone_id");
        const who = str(raw, "pubkey");
        const position = numbers(raw.position);
        const z = this.zoneList.find((x) => x.zoneId === zoneId);
        if (z) z.positions[who] = position;
        this.emit({ type: "position", zoneId, publicKey: who, position });
        break;
      }
      case "voice_joined":
        break;
      default:
        this.emit({ type: "unknown", raw });
    }
  }

  private onDatagram(payload: Uint8Array) {
    // sender_id[2] || packet_type[1] || key_id[4] || ctr[8] || ts[4] || AEAD
    if (payload.length < 3 + 32 || this.deafened) return;
    const senderId = (payload[0]! << 8) | payload[1]!;
    const whisper = payload[2] === 1;
    const sealed = payload.subarray(3);
    const v = view(sealed);
    const keyId = v.getUint32(0, false);
    const ctr = v.getBigUint64(4, false);
    const from = this.rosterMap.get(senderId)?.publicKey;
    if (from === undefined) return;
    const k = this.remote.get(`${from}/${keyId}`);
    if (!k) return;
    const mark = `${senderId}/${keyId}`;
    const seen = this.marks.get(mark);
    if (seen !== undefined && ctr <= seen) return;
    let opened: ReturnType<typeof voicePacketOpen>;
    try {
      opened = voicePacketOpen(k.key, k.salt, sealed);
    } catch {
      return;
    }
    // The watermark moves only for a packet that opened: a forged one must
    // not be able to lock the real sender out.
    this.marks.set(mark, ctr);
    this.emit({ type: "audio", from, senderId, keyId, ts: opened.ts, ctr, whisper, opus: opened.opus });
  }

  /** Every 25 ms: end a transmission that went quiet, and send the trailing position once the hub's limit is safely behind. */
  private housekeeping() {
    if (!this.inRoom) return;
    const now = performance.now();
    if (this.speaking && now - this.lastSend > SPEAKING_IDLE_MS) {
      this.speaking = false;
      this.trySend({ type: "voice_speaking", channel_id: this._channelId, speaking: false });
    }
    if (this.position && now - this.lastPosition >= POSITION_EVERY_MS) {
      const { zoneId, position } = this.position;
      this.position = undefined;
      this.lastPosition = now;
      this.trySend({ type: "voice_position_update", zone_id: zoneId, position });
    }
  }
}
