# @wavvon/sdk

Write programs that talk to a [Wavvon](https://github.com/Wavvon) hub: bots,
apps with slash commands and buttons, event consumers, mini-app hosts, and
receivers for outgoing webhooks.

A program on Wavvon is a client like any other: an Ed25519 keypair, the same
challenge-response login, the same permissions. There is no bot account. What
makes a program an *app* is a role carrying `apps.register`. The design this
package implements is
[sdk.md](https://github.com/Wavvon/Wavvon-docs/blob/main/docs/sdk.md) (tier 1).

- TypeScript, ESM, strict types. Node 20 or later, and browsers.
- Depends on `@noble/curves`, `@noble/hashes` and `openapi-fetch`. Nothing else.
- Apache-2.0, so a closed-source program can use it.

## Install

```sh
npm install @wavvon/sdk
```

On Node 20, pass a WebSocket implementation (the `ws` package) as
`new WavvonClient({ ..., WebSocket })`. Node 22+ and browsers have one built in.

## Quick start

```js
import { createServer } from "node:http";
import { WavvonClient, createDispatchHandler, toNodeListener } from "@wavvon/sdk";

const client = new WavvonClient({
  hubUrl: "https://hub.example",
  seed: process.env.WAVVON_SEED,          // 32-byte Ed25519 seed, hex. Never sent anywhere.
  inviteCode: process.env.WAVVON_INVITE,  // only needed the first time, on an invite-only hub
});
const { public_key: hubPublicKey } = await client.info();

createServer(toNodeListener(createDispatchHandler({
  hubPublicKey,
  onSlashCommand: (inv) => ({ reply: { body: `you said: ${inv.args_raw}` } }),
}))).listen(8080);

await client.setAppProfile({ name: "Echo", webhook_url: "https://bot.example/hook" });
await client.setAppCommands([{ name: "echo", description: "Repeat after me" }]);

const events = client.connect();
events.on("message", ({ message }) => console.log(message.sender, message.content));
events.on("unknown", (e) => console.log("new frame type:", e.rawType));
```

A fuller one is [examples/echo-bot.mjs](examples/echo-bot.mjs).

## What is in it

| Piece | Entry point |
|---|---|
| Login (challenge, sign, verify) that renews itself | `WavvonClient`, `authenticate`, `identityFromSeed` |
| Every REST route, typed from `openapi.yaml` | `client.rest.GET/POST/PUT/PATCH/DELETE` |
| Retry with backoff on 429, 5xx, timeouts | built into `client.rest`; `fetchWithRetry` |
| Capability checks | `client.hasCapability`, `client.requireCapability` |
| Keyset paging to the end of a list | `paginate` |
| WebSocket events with resume after reconnect | `client.connect()` -> `EventStream` |
| HTTP polling instead of a socket | `client.pollEvents(cursor)` |
| App registration | `setAppProfile`, `setAppCommands`, `setAppSubscriptions` |
| Slash command and button webhooks | `createDispatchHandler`, `verifyDispatch` |
| Outgoing webhook receiver | `verifyOutgoingWebhook` |
| Mini-app host | `EventStream.announceApp`, `dismissApp`, `sendMiniAppMessage` |

## Capabilities each feature needs

Hubs say what they support in `GET /info` `capabilities`. The SDK checks those
strings and never compares version numbers. A feature the hub does not
advertise throws `UnsupportedByHubError`.

| Feature | Capability |
|---|---|
| `setAppProfile`, `setAppCommands`, `setAppSubscriptions`, embeds, game cards | `apps.register` |
| `verifyDispatch` / `verifyOutgoingWebhook` (they require `X-Wavvon-Signature-V1`) | `webhooks.signedtimestamp` |
| Paging `GET /users`, `/conversations/{id}/messages`, `/admin/reports` | `list.cursor` |
| Paging bans, mutes, invites, pending, conversations, pins, polls | `list.cursor.lists` |
| `ping` / `pong` over the socket | `ws.ping` |

Login, REST, the socket and polling need no capability.

## Behaviour you can rely on

- **A transient failure is never an answer.** 429, 5xx, timeouts and dropped
  connections are retried with capped exponential backoff and jitter. If the
  budget runs out you get `HubUnavailableError`, not an empty list or a 404.
  Set `retry: { maxAttempts: Infinity }` to wait forever.
- **Sessions renew themselves.** A 401 triggers one fresh login and a retry.
  `client.onStateChange` and `events.onStateChange` show when it is happening.
- **Unknown is delivered.** A socket frame or dispatch type this version does
  not model reaches you as `{ type: "unknown", rawType, raw }`.
- **Missed events are replayed.** The event stream remembers the last
  `hub_event` seq and asks the hub to resume from it after every reconnect.
  If the gap is older than the hub keeps (72 hours) you get
  `replay_unavailable`. Register the app profile before `connect()`: the hub
  only pushes and replays events on a socket opened by a registered app.
- **The seed stays with you.** No call sends a seed or private key anywhere.

## Conformance

Every signed byte sequence is checked against the shared wire vectors in
Wavvon-server (`crates/identity/wire-vectors.json`): the auth challenge, the
Ed25519 dispatch signature, and the outgoing-webhook HKDF + HMAC. CI reads them
from Wavvon-server at commit `eb11d75657ee8362dd42a7982fc5b13a3dcc4e68`, a pin
moved on purpose when the vectors change.

The REST types were generated from Wavvon-docs at the commit in
[src/generated/SPEC_COMMIT](src/generated/SPEC_COMMIT).

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
