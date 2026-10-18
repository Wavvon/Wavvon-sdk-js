import { describe, expect, it } from "vitest";
import { WavvonError, paginate } from "../src/index.js";

const rows = Array.from({ length: 7 }, (_, i) => ({ code: `c${i}` }));

/** A hub-like keyset endpoint: rows after the cursor, at most `limit`. */
const endpoint = async (cursor: string | undefined, limit: number) => {
  const from = cursor === undefined ? 0 : rows.findIndex((r) => r.code === cursor) + 1;
  return rows.slice(from, from + limit);
};

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe("paginate", () => {
  it("walks every page, not just the first", async () => {
    expect(await collect(paginate(endpoint, (r) => r.code, 3))).toEqual(rows);
  });

  it("stops on an exactly full last page after one empty fetch", async () => {
    const cursors: (string | undefined)[] = [];
    const got = await collect(
      paginate(async (c, l) => (cursors.push(c), endpoint(c, l)), (r) => r.code, 7),
    );
    expect(got).toEqual(rows);
    expect(cursors).toEqual([undefined, "c6"]);
  });

  it("clamps the page size to what the hub serves", async () => {
    const limits: number[] = [];
    await collect(paginate(async (c, l) => (limits.push(l), endpoint(c, l)), (r) => r.code, 10_000));
    expect(limits[0]).toBe(500);
  });

  it("refuses to loop on a hub that ignores the cursor", async () => {
    const full = async (_c: string | undefined, l: number) => rows.slice(0, l);
    await expect(collect(paginate(full, (r) => r.code, 3))).rejects.toBeInstanceOf(WavvonError);
  });

  it("propagates a failed page instead of ending the list", async () => {
    const failing = async (c: string | undefined, l: number) => {
      if (c) throw new Error("503");
      return endpoint(c, l);
    };
    await expect(collect(paginate(failing, (r) => r.code, 3))).rejects.toThrow("503");
  });
});
