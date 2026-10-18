import { describe, expect, it } from "vitest";
import { EventStream, parseFrame, type WebSocketLike, type WsEvent } from "../src/index.js";

describe("parseFrame", () => {
  it("types known frames", () => {
    const e = parseFrame(JSON.stringify({ type: "replay_unavailable", earliest_seq: 5, earliest_at: 1 }));
    expect(e.type).toBe("replay_unavailable");
  });

  it("delivers unknown types with the raw payload", () => {
    const raw = { type: "voice_zone_created", zone_id: "z" };
    expect(parseFrame(JSON.stringify(raw))).toEqual({ type: "unknown", rawType: "voice_zone_created", raw });
  });

  it("delivers garbage and binary frames as unknown too", () => {
    expect(parseFrame("{nope")).toMatchObject({ type: "unknown", rawType: "" });
    expect(parseFrame(new Uint8Array([1]))).toMatchObject({ type: "unknown", rawType: "binary" });
  });
});

/** Scripted sockets: each new connection is pushed here for the test to drive. */
class FakeSocket implements WebSocketLike {
  static all: FakeSocket[] = [];
  readyState = 1;
  sent: unknown[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.onclose?.({});
  }
  frame(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
}

const tick = () => new Promise((r) => setTimeout(r, 15));
const hubEvent = (seq: number) => ({ type: "hub_event", seq, event: "member.joined", hub_url: "h", at: 1, payload: {} });

describe("EventStream", () => {
  it("resumes from the last seq after a reconnect and drops replay duplicates", async () => {
    FakeSocket.all = [];
    let reauths = 0;
    const states: string[] = [];
    const stream = new EventStream({
      url: async () => "ws://hub/ws?token=t",
      reauthenticate: async () => void reauths++,
      WebSocket: FakeSocket,
      retry: { baseDelayMs: 1, maxDelayMs: 1 },
    });
    stream.onStateChange((s) => states.push(s));
    const got: WsEvent[] = [];
    stream.on("*", (e) => got.push(e));
    await tick();

    const first = FakeSocket.all[0]!;
    first.frame({ type: "hello", live_seq: 10 });
    expect(first.sent).toEqual([]);
    first.frame(hubEvent(11));
    first.frame(hubEvent(12));
    first.close();
    await tick();

    const second = FakeSocket.all[1]!;
    second.frame({ type: "hello", live_seq: 20 });
    expect(second.sent).toEqual([{ type: "resume", since_seq: 12 }]);
    second.frame(hubEvent(12));
    second.frame(hubEvent(13));
    second.frame({ type: "replay_unavailable", earliest_seq: 1, earliest_at: 2 });

    const seqs = got.filter((e) => e.type === "hub_event").map((e) => (e as { seq: number }).seq);
    expect(seqs).toEqual([11, 12, 13]);
    expect(got.some((e) => e.type === "replay_unavailable")).toBe(true);
    expect(states).toEqual(["open", "reconnecting", "open"]);
    expect(reauths).toBe(0);
    stream.close();
  });

  it("re-authenticates when a connection dies before hello", async () => {
    FakeSocket.all = [];
    let reauths = 0;
    const stream = new EventStream(
      {
        url: async () => "ws://hub/ws",
        reauthenticate: async () => void reauths++,
        WebSocket: FakeSocket,
        retry: { baseDelayMs: 1, maxDelayMs: 1 },
      },
      { sinceSeq: 4 },
    );
    await tick();
    FakeSocket.all[0]!.close();
    await tick();
    expect(reauths).toBe(1);
    const s = FakeSocket.all[1]!;
    s.frame({ type: "hello", live_seq: 9 });
    expect(s.sent).toEqual([{ type: "resume", since_seq: 4 }]);
    stream.close();
    expect(stream.state).toBe("closed");
  });
});
