// Boots a real hub binary with a fresh database, sets it up as its owner
// (a role carrying apps.register, an invite granting it, a channel), then runs
// test/smoke.mjs against it. Mirrors Wavvon-server's e2e harness.
//
//   WAVVON_HUB_BIN   hub binary (default ../../server/target/debug/wavvon-hub[.exe])
//   WAVVON_PG        PostgreSQL base URL (default postgres://postgres:postgres@localhost:5432)
//   WAVVON_PG_CONTAINER  docker container used to create the database (default wavvon-pg)
//
// Needs `npm run build` and a running PostgreSQL. Does not build the hub.

import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WavvonClient, ok } from "../dist/index.js";

const root = resolve(import.meta.dirname, "..");
const exe = process.platform === "win32" ? "wavvon-hub.exe" : "wavvon-hub";
const bin = process.env.WAVVON_HUB_BIN ?? resolve(root, "../../server/target/debug", exe);
if (!existsSync(bin)) {
  console.error(`no hub binary at ${bin}; build Wavvon-server (cargo build -p wavvon-hub) or set WAVVON_HUB_BIN`);
  process.exit(2);
}

const pg = process.env.WAVVON_PG ?? "postgres://postgres:postgres@localhost:5432";
const container = process.env.WAVVON_PG_CONTAINER ?? "wavvon-pg";
const db = "wavvon_sdk_smoke";
const psql = (sql) => execFileSync("docker", ["exec", container, "psql", "-U", "postgres", "-c", sql], { stdio: "pipe" });

const httpPort = 3900 + Math.floor(Math.random() * 500);
const hubUrl = `http://localhost:${httpPort}`;
const cwd = mkdtempSync(join(tmpdir(), "wavvon-sdk-smoke-"));
const ownerSeed = randomBytes(32);
const owner = new WavvonClient({ hubUrl, seed: ownerSeed });

psql(`DROP DATABASE IF EXISTS ${db}`);
psql(`CREATE DATABASE ${db}`);

const log = [];
const hub = spawn(bin, [], {
  cwd,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    WAVVON_DATABASE_URL: `${pg}/${db}`,
    WAVVON_HTTP_PORT: String(httpPort),
    WAVVON_VOICE_UDP_PORT: String(httpPort + 1),
    WAVVON_PUBLIC_URL: hubUrl,
    WAVVON_OWNER_PUBKEY: owner.identity.publicKey,
    WAVVON_WEB_CLIENT_DIR: "",
  },
});
hub.stdout.on("data", (b) => log.push(String(b)));
hub.stderr.on("data", (b) => log.push(String(b)));

function teardown() {
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(hub.pid), "/T", "/F"], { stdio: "ignore" });
    else hub.kill("SIGKILL");
  } catch {
    // already gone
  }
  try {
    rmSync(cwd, { recursive: true, force: true });
  } catch {
    // Windows may hold a file a moment longer; it is a temp dir
  }
}

let code = 1;
try {
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (hub.exitCode !== null) throw new Error(`hub exited (${hub.exitCode})\n${log.join("")}`);
    try {
      if ((await fetch(`${hubUrl}/info`)).ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`hub never answered\n${log.join("")}`);
    await new Promise((r) => setTimeout(r, 400));
  }
  console.log(`smoke-local: hub up at ${hubUrl}`);

  const role = ok(await owner.rest.POST("/roles", { body: { name: "Apps", priority: 10, permissions: ["apps.register"] } }));
  const invite = ok(await owner.rest.POST("/invites", { body: { grant_role_id: role.id, max_uses: 1 } }));
  const channel = ok(await owner.rest.POST("/channels", { body: { name: "sdk-smoke" } }));
  console.log("smoke-local: role, invite and channel ready");

  const child = spawn(process.execPath, [join(root, "test/smoke.mjs")], {
    stdio: "inherit",
    env: {
      ...process.env,
      WAVVON_SMOKE_HUB: hubUrl,
      WAVVON_SMOKE_INVITE: invite.code,
      WAVVON_SMOKE_CHANNEL: channel.id,
    },
  });
  code = await new Promise((r) => child.on("close", r));
  if (code !== 0 && process.env.WAVVON_SMOKE_VERBOSE) console.log(log.join(""));
} catch (e) {
  console.error(e?.stack ?? e);
} finally {
  teardown();
}
process.exit(code);
