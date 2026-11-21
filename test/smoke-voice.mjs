// Smoke test of voice against a real hub: the owner and a second identity
// share a room, and every assertion needs a decrypted frame whose bytes match
// what the other side sent, never a roster row. Nothing is played. Without an
// Opus encoder the frames are fixed 20 ms TOC bytes with a numbered payload;
// the hub relays them sealed and never decodes them.
//
//   WAVVON_SMOKE_HUB=http://localhost:3400 [WAVVON_SMOKE_SEED=<64 hex>] node test/smoke-voice.mjs
//
// The seed identity (default `5a` repeated) must be a hub owner, so it can
// create the channel and mint the invite the second identity joins with.
// Needs `npm run build` and the `werift` package.

import { randomBytes } from "node:crypto";
import { VoiceError, WavvonClient, ok } from "../dist/index.js";

const hubUrl = process.env.WAVVON_SMOKE_HUB;
if (!hubUrl) {
  console.error("set WAVVON_SMOKE_HUB");
  process.exit(2);
}
const say = (s) => console.log(`voice smoke: ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, cond) {
  for (let i = 0; i < 600; i++) {
    if (cond()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function watch(voice) {
  const seen = { frames: [], zones: [], positions: [], refused: [], rejoining: 0, skipped: [] };
  void (async () => {
    for await (const ev of voice) {
      if (ev.type === "audio") seen.frames.push(ev);
      else if (ev.type === "zones") seen.zones = ev.zones.map((z) => z.zoneId);
      else if (ev.type === "position") seen.positions.push(ev.position);
      else if (ev.type === "position_refused") seen.refused.push(ev.reason);
      else if (ev.type === "rejoining") seen.rejoining++;
      else if (ev.type === "key_skipped") seen.skipped.push(ev.publicKey);
      else if (ev.type === "error") console.error(`voice error: ${ev.error.message}`);
    }
  })();
  return seen;
}

/** CELT fullband, one 20 ms frame; the payload carries a tag and the frame number. */
function frame(tag, i) {
  const f = new Uint8Array(80);
  f[0] = 0xf8;
  f[1] = tag;
  new DataView(f.buffer).setUint32(2, i);
  for (let n = 6; n < f.length; n++) f[n] = (n * 7 + i) & 0xff;
  return f;
}
const sameAs = (a, tag) => {
  const i = new DataView(a.opus.buffer, a.opus.byteOffset).getUint32(2);
  const want = frame(tag, i);
  return a.opus.length === want.length && a.opus.every((b, n) => b === want[n]);
};

function speak(voice, tag, n) {
  return (async () => {
    for (let i = 0; i < n; i++) await voice.sendOpus(frame(tag, i));
  })();
}

function heard(seen, from, tag, minKey = 1) {
  return seen.frames.filter((a) => a.from === from && a.keyId >= minKey && sameAs(a, tag)).length;
}

const a = new WavvonClient({ hubUrl, seed: process.env.WAVVON_SMOKE_SEED ?? "5a".repeat(32) });
await a.login();
const bSeed = randomBytes(32);
const bProbe = new WavvonClient({ hubUrl, seed: bSeed });
const invite = ok(await a.rest.POST("/invites", { body: { bound_pubkey: bProbe.identity.publicKey } }));
const b = new WavvonClient({ hubUrl, seed: bSeed, inviteCode: invite.code });
await b.login();
const aKey = a.identity.publicKey;
const bKey = b.identity.publicKey;

const channel = ok(await a.rest.POST("/channels", { body: { name: `voice-smoke-${bKey.slice(0, 6)}`, channel_type: "voice" } }));

const va = await a.joinVoice(channel.id);
const vb = await b.joinVoice(channel.id);
say(`both joined: A is sender ${va.senderId}, B is ${vb.senderId}`);
const seenA = watch(va);
const seenB = watch(vb);

// A speaks; B must open what it hears, byte for byte.
let sending = speak(va, 0xa1, 200);
await until("B to open 100 frames from A", () => heard(seenB, aKey, 0xa1) >= 100);
await sending;
if (seenB.frames.some((f) => f.from === aKey && !sameAs(f, 0xa1))) throw new Error("B opened a frame that is not A's");
say(`B opened ${heard(seenB, aKey, 0xa1)} of A's 200 frames, each byte-identical`);

sending = speak(vb, 0xb2, 200);
await until("A to open 100 frames from B", () => heard(seenA, bKey, 0xb2) >= 100);
await sending;
say(`A opened ${heard(seenA, bKey, 0xb2)} of B's 200 frames, each byte-identical`);

// A frame that is not 20 ms is refused before anything is sent.
try {
  await va.sendOpus(Uint8Array.of(0xf9, 0, 0));
  throw new Error("a 40 ms packet was accepted");
} catch (e) {
  if (!(e instanceof VoiceError) || e.kind !== "bad_frame") throw e;
  say(`a 40 ms packet is refused (${e.message})`);
}

// Rotation: B leaves, so A's key changes to 2; B rejoins and must open it.
await vb.leave();
const vb2 = await b.joinVoice(channel.id);
const seenB2 = watch(vb2);
sending = speak(va, 0xa3, 200);
await until("B's second session to open key_id >= 2", () => heard(seenB2, aKey, 0xa3, 2) >= 50);
await sending;
say(`after B left, A rotated to key_id ${Math.max(...seenB2.frames.map((f) => f.keyId))} and B opened ${heard(seenB2, aKey, 0xa3, 2)} frames under it`);

// Proximity: ten positions in 100 ms end at the last one.
va.createZone("smoke-zone", "smoke", "2d", {}, "any_channel_member");
await until("both to see the zone", () => seenB2.zones.includes("smoke-zone") && va.zones().some((z) => z.zoneId === "smoke-zone"));
const t0 = Date.now();
for (let i = 0; i < 10; i++) {
  va.setPosition("smoke-zone", [10 + i, 50]);
  await sleep(10);
}
// One update per 50 ms window the loop spanned, plus the first and the final
// flush; timer slop stretches the loop, and nine keeps it a coalescing test.
const limit = Math.min(9, Math.ceil((Date.now() - t0) / 50) + 2);
await until("B to see the last position", () => {
  const last = seenB2.positions.at(-1);
  return last?.[0] === 19 && last?.[1] === 50;
});
const n = seenB2.positions.length;
if (n > limit) throw new Error(`coalescing let ${n} of 10 positions through (limit ${limit})`);
say(`ten positions in 100 ms coalesced to ${n}, ending at the last`);

// A position in someone else's creator-only zone is refused, as an event.
va.createZone("own-zone", "own", "2d", {}, "creator_only");
await until("B to see the creator-only zone", () => vb2.zones().some((z) => z.zoneId === "own-zone"));
vb2.setPosition("own-zone", [1, 1]);
await until("B to be refused", () => seenB2.refused.length > 0);
say(`B's position was refused: ${seenB2.refused[0]}`);

if (seenA.skipped.length) throw new Error(`A skipped ${seenA.skipped}`);
if (seenA.rejoining) throw new Error("A rejoined");
await va.leave();
await vb2.leave();
say("VOICE SMOKE OK");
process.exit(0);
