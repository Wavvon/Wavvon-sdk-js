// Smoke test against a real hub, through the built package's public API only.
// Not run by vitest: it needs a hub. `npm run build` first.
//
//   WAVVON_SMOKE_HUB      hub URL, e.g. http://localhost:3600
//   WAVVON_SMOKE_INVITE   an invite whose role grants apps.register
//   WAVVON_SMOKE_CHANNEL  optional channel id; default: the first text channel
//   WAVVON_SMOKE_WEBHOOK_HOST  host the hub can reach this process at (default localhost)
//
// Authenticates as a fresh identity, posts a message, registers a slash
// command, invokes it, checks that the verified invocation's reply lands
// in the channel, and polls the message back from GET /me/events. scripts/smoke-local.mjs boots a hub and runs this.

import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { WavvonClient, createDispatchHandler, ok, toNodeListener } from "../dist/index.js";

const hubUrl = process.env.WAVVON_SMOKE_HUB;
const inviteCode = process.env.WAVVON_SMOKE_INVITE;
if (!hubUrl || !inviteCode) {
  console.error("set WAVVON_SMOKE_HUB and WAVVON_SMOKE_INVITE");
  process.exit(2);
}

const step = (s) => console.log(`smoke: ${s}`);
const fail = (s) => {
  console.error(`smoke: FAILED: ${s}`);
  process.exit(1);
};
const within = (ms, what, p) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out waiting for ${what}`)), ms))]);

const client = new WavvonClient({
  hubUrl,
  seed: randomBytes(32),
  inviteCode,
  retry: { onRetry: (i) => step(`retrying after ${i.status ?? "network error"} (attempt ${i.attempt})`) },
});

try {
  const session = await client.login();
  step(`authenticated as ${session.canonicalPubkey} (${session.scope})`);
  await client.requireCapability("apps.register");
  await client.requireCapability("webhooks.signedtimestamp");
  const info = await client.info();

  let invocation;
  const server = createServer(
    toNodeListener(
      createDispatchHandler({
        hubPublicKey: info.public_key,
        onSlashCommand: (inv) => {
          invocation = inv;
          return { reply: { body: `pong: ${inv.args_raw}` } };
        },
      }),
    ),
  );
  await new Promise((r) => server.listen(0, r));
  const webhookUrl = `http://${process.env.WAVVON_SMOKE_WEBHOOK_HOST ?? "localhost"}:${server.address().port}/hook`;

  await client.setAppProfile({ name: "SDK smoke", description: "@wavvon/sdk smoke test", webhook_url: webhookUrl });
  await client.setAppCommands([{ name: "sdksmoke", description: "Answers pong", cooldown_seconds: 0 }]);
  step(`registered /sdksmoke -> ${webhookUrl}`);

  // After the profile, so the hub treats this socket as an app's.
  const stream = client.connect();
  const seen = [];
  const unknown = [];
  stream.on("message", (e) => seen.push(e.message));
  stream.on("unknown", (e) => unknown.push(e.rawType));
  await within(10_000, "the socket", new Promise((r) => stream.onStateChange((s) => s === "open" && r())));
  step("socket open");

  let channelId = process.env.WAVVON_SMOKE_CHANNEL;
  if (!channelId) {
    const channels = ok(await client.rest.GET("/channels"));
    channelId = channels.find((c) => !c.is_category && (c.channel_type ?? "text") === "text")?.id;
    if (!channelId) fail("no text channel to post in");
  }
  await client.setAppSubscriptions([{ event: "message.created", channels: [channelId] }]);

  const waitFor = (pred, what) =>
    within(
      10_000,
      what,
      new Promise((r) => {
        const t = setInterval(() => {
          const hit = seen.find(pred);
          if (hit) {
            clearInterval(t);
            r(hit);
          }
        }, 50);
      }),
    );

  const text = `hello from @wavvon/sdk ${Date.now()}`;
  ok(await client.rest.POST("/channels/{channel_id}/messages", { params: { path: { channel_id: channelId } }, body: { content: text } }));
  await waitFor((m) => m.content === text, "our own message over the socket");
  step("posted a message and saw it come back");

  ok(await client.rest.POST("/channels/{channel_id}/messages", { params: { path: { channel_id: channelId } }, body: { content: "/sdksmoke ping" } }));
  const reply = await waitFor((m) => m.content === "pong: ping", "the slash command reply");
  if (invocation?.command !== "sdksmoke" || invocation.args_raw !== "ping") fail(`odd invocation ${JSON.stringify(invocation)}`);
  if (reply.sender !== session.canonicalPubkey) fail(`reply sent by ${reply.sender}`);
  step("verified the invocation and the reply landed");

  const polled = await client.pollEvents();
  const ours = polled.find((e) => e.event === "message.created" && e.payload?.content === text);
  if (!ours) fail(`polling did not return our message: ${JSON.stringify(polled.map((e) => e.event))}`);
  const after = await client.pollEvents(polled.at(-1).seq);
  if (after.some((e) => e.seq <= polled.at(-1).seq)) fail("the cursor did not page forward");
  step(`polled ${polled.length} events, ours at seq ${ours.seq}`);

  if (unknown.length) step(`frames this SDK does not model (delivered as unknown): ${[...new Set(unknown)].join(", ")}`);
  stream.close();
  server.close();
  step("PASSED");
  process.exit(0);
} catch (e) {
  fail(e?.stack ?? String(e));
}
