// Echoes every message in the channels it can read, and answers /echo.
//
//   WAVVON_HUB=https://hub.example  WAVVON_SEED=<64 hex chars>  \
//   WAVVON_INVITE=<code, first run only>  WAVVON_WEBHOOK_URL=https://bot.example/hook  \
//   PORT=8080 node examples/echo-bot.mjs
//
// The identity needs a role carrying apps.register to register /echo. The
// hub POSTs invocations to WAVVON_WEBHOOK_URL, which must reach PORT here.

import { createServer } from "node:http";
import { WavvonClient, createDispatchHandler, toNodeListener } from "@wavvon/sdk";

const client = new WavvonClient({
  hubUrl: process.env.WAVVON_HUB,
  seed: process.env.WAVVON_SEED,
  inviteCode: process.env.WAVVON_INVITE,
});
const me = (await client.login()).canonicalPubkey;
const { public_key: hubPublicKey } = await client.info();

createServer(
  toNodeListener(
    createDispatchHandler({
      hubPublicKey,
      onSlashCommand: (inv) => ({ reply: { body: inv.args_raw || "(nothing to echo)" }, ephemeral: true }),
    }),
  ),
).listen(Number(process.env.PORT ?? 8080));

await client.setAppProfile({ name: "Echo", webhook_url: process.env.WAVVON_WEBHOOK_URL });
await client.setAppCommands([{ name: "echo", description: "Repeat what you say, to you only", args: "<text>" }]);

const events = client.connect();
events.onStateChange((s) => console.log(`socket: ${s}`));
events.on("unknown", (e) => console.log(`unmodelled frame: ${e.rawType}`));
events.on("message", async ({ channel_id, message }) => {
  if (message.sender === me || message.visible_to_pubkey || message.content?.startsWith("/")) return;
  await client.rest.POST("/channels/{channel_id}/messages", {
    params: { path: { channel_id } },
    body: { content: `echo: ${message.content}` },
  });
});
