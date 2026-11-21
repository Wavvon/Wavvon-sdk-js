import { describe, expect, it } from "vitest";
import { opusDurationUs } from "../src/index.js";

describe("opusDurationUs", () => {
  it("reads the TOC byte", () => {
    expect(opusDurationUs(Uint8Array.of(0x08))).toBe(20_000); // SILK NB 20 ms
    expect(opusDurationUs(Uint8Array.of(0xf8))).toBe(20_000); // CELT FB 20 ms
    expect(opusDurationUs(Uint8Array.of(0xf0))).toBe(10_000);
    expect(opusDurationUs(Uint8Array.of(0xf9))).toBe(40_000); // two frames
    expect(opusDurationUs(Uint8Array.of(0x1b, 3))).toBe(180_000); // 60 ms x 3
    expect(opusDurationUs(Uint8Array.of(0x78))).toBe(20_000); // hybrid FB 20 ms
  });

  it("refuses what it cannot read", () => {
    expect(() => opusDurationUs(new Uint8Array())).toThrow();
    expect(() => opusDurationUs(Uint8Array.of(0xfb))).toThrow();
    expect(() => opusDurationUs(Uint8Array.of(0xfb, 0))).toThrow();
  });
});
