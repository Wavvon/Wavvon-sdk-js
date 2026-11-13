import { describe, expect, it } from "vitest";
import { HubUnavailableError, ReplayUnavailableError, UnsupportedByHubError, WavvonClient } from "../src/index.js";

const seed = "02".repeat(32);

/** A hub with a token that can be revoked mid-run and a flaky /channels. */
function fakeHub(capabilities: string[]) {
  let tokens = 0;
  let valid = "";
  let flaky = 0;
  const log: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const path = new URL(req.url).pathname;
    log.push(`${req.method} ${path}`);
    if (path === "/info") return Response.json({ public_key: "aa", capabilities });
    if (path === "/auth/challenge") return Response.json({ challenge: "00".repeat(32), scheme: "tagged-v1" });
    if (path === "/auth/verify") {
      valid = `t${++tokens}`;
      return Response.json({ token: valid, scope: "member", canonical_pubkey: "me" });
    }
    if (req.headers.get("authorization") !== `Bearer ${valid}`) return new Response("expired", { status: 401 });
    if (path === "/channels" && flaky-- > 0) return new Response(null, { status: 429 });
    if (path === "/me/app/commands") return new Response(null, { status: 200 });
    if (path === "/me/events") {
      const cursor = new URL(req.url).searchParams.get("cursor");
      log.push(`cursor=${cursor}`);
      if (cursor === "1") return Response.json({ type: "replay_unavailable", earliest_seq: 40, earliest_at: 9 }, { status: 410 });
      return Response.json([{ type: "hub_event", seq: 42, event: "member.joined", hub_url: "http://hub", at: 1, payload: {}, replayed: true }]);
    }
    return Response.json([{ id: "c1", name: "general" }]);
  }) as typeof fetch;
  return {
    fetchImpl,
    log,
    revoke: () => (valid = "revoked"),
    flake: (n: number) => (flaky = n),
  };
}

const fast = { baseDelayMs: 1, maxDelayMs: 1 };

describe("WavvonClient", () => {
  it("adds the bearer, re-authenticates once on 401 and retries the call", async () => {
    const hub = fakeHub([]);
    const client = new WavvonClient({ hubUrl: "http://hub", seed, fetch: hub.fetchImpl, retry: fast });
    const states: string[] = [];
    client.onStateChange((s) => states.push(s));
    expect((await client.rest.GET("/channels")).data).toHaveLength(1);
    hub.revoke();
    expect((await client.rest.GET("/channels")).response.status).toBe(200);
    expect(hub.log.filter((l) => l === "POST /auth/verify")).toHaveLength(2);
    expect(states).toEqual(["authenticating", "ready", "authenticating", "ready"]);
  });

  it("retries 429 and fails loudly once the budget is spent", async () => {
    const hub = fakeHub([]);
    const client = new WavvonClient({ hubUrl: "http://hub", seed, fetch: hub.fetchImpl, retry: { ...fast, maxAttempts: 3 } });
    hub.flake(2);
    expect((await client.rest.GET("/channels")).response.status).toBe(200);
    hub.flake(10);
    await expect(client.rest.GET("/channels")).rejects.toBeInstanceOf(HubUnavailableError);
  });

  it("gates app registration on the apps.register capability", async () => {
    const without = new WavvonClient({ hubUrl: "http://hub", seed, fetch: fakeHub([]).fetchImpl });
    await expect(without.setAppCommands([])).rejects.toBeInstanceOf(UnsupportedByHubError);
    const hub = fakeHub(["apps.register"]);
    const withCap = new WavvonClient({ hubUrl: "http://hub", seed, fetch: hub.fetchImpl });
    await withCap.setAppCommands([{ name: "echo", description: "Echo" }]);
    expect(hub.log).toContain("PUT /me/app/commands");
  });

  it("polls hub_event envelopes after a cursor and reports a cursor outside the window", async () => {
    const hub = fakeHub([]);
    const client = new WavvonClient({ hubUrl: "http://hub", seed, fetch: hub.fetchImpl });
    const events = await client.pollEvents(41);
    expect(events.map((e) => e.seq)).toEqual([42]);
    expect(hub.log).toContain("cursor=41");
    const gone = await client.pollEvents(1).catch((e: unknown) => e);
    expect(gone).toBeInstanceOf(ReplayUnavailableError);
    expect((gone as ReplayUnavailableError).earliestSeq).toBe(40);
  });
});
