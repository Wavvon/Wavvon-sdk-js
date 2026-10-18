import { describe, expect, it } from "vitest";
import { AuthSchemeError, HubUnavailableError, backoffDelay, fetchWithRetry, isTransientStatus } from "../src/index.js";

const noSleep = { sleep: async () => {}, random: () => 1 };

describe("retry", () => {
  it("treats 429 and 5xx as transient, other statuses as answers", () => {
    expect([429, 500, 502, 503].every(isTransientStatus)).toBe(true);
    expect([200, 400, 401, 403, 404].some(isTransientStatus)).toBe(false);
  });

  it("backs off exponentially up to the cap", () => {
    const d = (n: number) => backoffDelay(n, { baseDelayMs: 100, maxDelayMs: 1000 }, () => 1);
    expect([d(1), d(2), d(3), d(4), d(5), d(9)]).toEqual([100, 200, 400, 800, 1000, 1000]);
    expect(backoffDelay(3, {}, () => 0)).toBe(0);
  });

  it("retries 429 until an answer arrives", async () => {
    const statuses = [429, 503, 200];
    const seen: number[] = [];
    const res = await fetchWithRetry(
      async () => new Response(null, { status: statuses.shift()! }),
      { onRetry: (i) => seen.push(i.status!) },
      noSleep,
    );
    expect(res.status).toBe(200);
    expect(seen).toEqual([429, 503]);
  });

  it("retries network errors", async () => {
    let n = 0;
    const res = await fetchWithRetry(
      async () => {
        if (n++ < 2) throw new TypeError("fetch failed");
        return new Response("ok");
      },
      {},
      noSleep,
    );
    expect(await res.text()).toBe("ok");
  });

  it("retries timeouts", async () => {
    let n = 0;
    const res = await fetchWithRetry(
      async () => {
        if (n++ < 1) throw new DOMException("timed out", "TimeoutError");
        return new Response("ok");
      },
      {},
      noSleep,
    );
    expect(await res.text()).toBe("ok");
  });

  it("rethrows non-transport errors without retrying", async () => {
    for (const err of [new AuthSchemeError("unknown scheme"), new RangeError("bug")]) {
      let calls = 0;
      const p = fetchWithRetry(
        async () => {
          calls++;
          throw err;
        },
        {},
        noSleep,
      );
      await expect(p).rejects.toBe(err);
      expect(calls).toBe(1);
    }
  });

  it("never returns a transient failure as the answer", async () => {
    const p = fetchWithRetry(async () => new Response(null, { status: 429 }), { maxAttempts: 3 }, noSleep);
    await expect(p).rejects.toBeInstanceOf(HubUnavailableError);
    await expect(p).rejects.toMatchObject({ lastStatus: 429 });
  });

  it("returns a definitive refusal without retrying", async () => {
    let calls = 0;
    const res = await fetchWithRetry(async () => (calls++, new Response(null, { status: 403 })), {}, noSleep);
    expect(res.status).toBe(403);
    expect(calls).toBe(1);
  });
});
