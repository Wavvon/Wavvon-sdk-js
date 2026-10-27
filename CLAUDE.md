# CLAUDE.md

Guidance for working in this repo: `@wavvon/sdk`, the TypeScript SDK for
programs (bots and apps) that talk to a Wavvon hub. The design is
[sdk.md](https://github.com/Wavvon/Wavvon-docs/blob/main/docs/sdk.md); this is
its tier 1. Hub code lives in
[Wavvon-server](https://github.com/Wavvon/Wavvon-server), the REST spec and
protocol docs in [Wavvon-docs](https://github.com/Wavvon/Wavvon-docs).

## Commands

```sh
npm ci
npm run check        # typecheck + eslint + vitest + build. Must pass before a commit.
npm test             # vitest only
npm run generate -- <path-to-Wavvon-docs> [--ref <git-ref>]   # regenerate REST types
npm run build && npm run smoke:local   # real hub binary, see below
```

Code comments in English, only where the why is not obvious. No comments in
GitHub Actions workflow files: explain choices in the commit message.

## Layers

1. **Generated REST** - `src/generated/schema.d.ts`, from Wavvon-docs
   `openapi.yaml` by `scripts/generate.mjs` (openapi-typescript). Committed.
   `src/generated/SPEC_COMMIT` records the docs commit; `-dirty` means local
   edits. The spec is used as-is: a gap in it is fixed in Wavvon-docs, not
   patched here. Never edit the generated file by hand.
2. **Hand-written core** - `src/`:
   - `auth.ts` challenge rules and login; `retry.ts` backoff; `client.ts`
     `WavvonClient` (openapi-fetch with a custom fetch that adds the bearer,
     retries and re-authenticates on 401), capabilities, app registration,
     polling; `pager.ts`; `events.ts` the WebSocket stream and frame types;
     `webhooks.ts` dispatch and outgoing-webhook verification, reply types and
     the Request -> Response handler.
3. **Conformance** - `test/conformance.test.ts` reads Wavvon-server
   `crates/identity/wire-vectors.json` (default path `../../server/...`, or
   `WAVVON_WIRE_VECTORS`). Strings starting with `@` refer to `fixtures`. It
   is never copied into this repo. Missing file: loud skip locally, failure
   when `CI` is set.

## Rules the SDK must keep (sdk.md §5, §6)

- **Capabilities, never versions.** Gate features on `GET /info`
  `capabilities` and throw `UnsupportedByHubError`. Never compare `version`.
- **429 is "not now", never "no".** Retry 429/5xx/timeouts/network errors with
  capped exponential backoff and jitter. On exhaustion throw
  `HubUnavailableError`; never turn a transient failure into an empty list,
  "not found", or any other definitive answer. A pager page that fails must
  throw, not end the list.
- **Unknown is loud.** Unknown socket frames and dispatch types are delivered
  as an `unknown` variant with the raw payload, never dropped.
- **Re-auth on its own**, with the state observable (`onStateChange`).
- **Auth challenge**: `scheme: "tagged-v1"` -> sign
  `"wavvon/auth-challenge/v1\0" || challenge`; a missing or any other scheme
  -> `AuthSchemeError`, never a raw signature.
- **Never send the seed** or any private key anywhere. Never invent a wire
  format: signed bytes come from wire-format.md and the vectors; a new one is
  a server-side change first. Never model a bot as an account or send
  `is_bot`. Tier 1 is community-axis only (no DMs E2E, pairing, home hub).

Code is authoritative over docs. When they disagree, follow the hub code and
report the doc bug to Wavvon-docs.

## Facts verified against the hub that the docs get wrong or omit

- `resume` and `hub_event` push only work on a socket whose identity had an
  app profile **when it connected** (`is_app` is read at connect). Register
  first, then `connect()`.
- The app side of a mini-app sends `app_announce` / `app_dismiss` and talks to
  players with `mini_app_message` + `to_pubkey`. `app_join` is answered by the
  hub, not the app.
- Paging: a bare array plus `limit` (default 100, max 500) and `cursor` = key
  of the previous page's last row; the key differs per endpoint (`code`,
  `public_key`, `id`); channel messages too since Wavvon-server#184.
- Outgoing-webhook HKDF input is the **decoded** secret bytes (the admin sees
  base64url without padding); the HMAC key is the 32 HKDF bytes, not hex.

## Smoke test

`test/smoke.mjs` runs against a real hub (`WAVVON_SMOKE_HUB`,
`WAVVON_SMOKE_INVITE` for an invite whose role grants `apps.register`,
optional `WAVVON_SMOKE_CHANNEL`). `scripts/smoke-local.mjs` boots a hub binary
(`WAVVON_HUB_BIN`, default a sibling Wavvon-server checkout's
`target/debug/wavvon-hub`) on a fresh database in a PostgreSQL docker container
(`WAVVON_PG_CONTAINER`, default `wavvon-pg`), sets up a role, invite and
channel as owner, and runs the smoke. In-process tests have missed every
cross-process bug this project has had: run it when touching auth, the
socket or webhooks.

## Git

Work on `develop`; `main` is for releases. Commit in logical steps.

## Releasing

Bump `version` in `package.json` on `develop`, open a PR from `develop` to
`main`; a maintainer merges it. `.github/workflows/release.yml` then runs on
`main`: if tag `v<version>` does not exist yet it runs the full check,
**stages** the version on npm with provenance through npm trusted publishing
(no token stored; the trusted publisher on the package settings page may only
`npm stage publish`), tags the commit and creates the GitHub release. The
version goes live only when a maintainer approves it on npmjs.com (Staged
Packages, with 2FA): a compromised CI cannot publish on its own. A version
already on npm is not restaged, only tagged.
