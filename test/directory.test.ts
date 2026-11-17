import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { DirectoryError, buildIdentityListing, identityFromSeed, publishListing, unpublishListing } from "../src/index.js";

const id = identityFromSeed("11".repeat(32));
const fromB64url = (s: string) => Uint8Array.from(Buffer.from(s, "base64url"));

/** A fetch that records requests and answers from a queue. */
function fakeFetch(answers: Response[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return answers.shift()!;
  };
  return { calls, fetch: f as typeof fetch };
}

describe("identity listing", () => {
  it("is byte-identical to the Wavvon clients' builder for a person's listing", () => {
    // What clients' packages/core buildIdentityListing returns for the same fields.
    const clients = JSON.stringify({
      format: "wavvon.identity", version: 1, pubkey: `ed25519:${id.publicKey}`, name: "Ada", tagline: "hi",
      description: "", kind: "person", tags: ["chess"], languages: ["it"],
      contact: { home_hub: "https://hub.example" }, listed_at: 7,
    });
    expect(buildIdentityListing({
      name: " Ada ", tagline: "hi", kind: "person", tags: ["chess"], languages: ["it"],
      contact: { home_hub: "https://hub.example/" }, listedAt: 7,
    }, id.publicKey)).toBe(clients);
  });

  it("puts the app block before listed_at and defaults kind to program", () => {
    const doc = JSON.parse(buildIdentityListing({
      name: "Tallyman", contact: { endpoint: "https://t.example/invites" }, app: { mini_app: true }, listedAt: 1,
    }, id.publicKey));
    expect(Object.keys(doc).slice(-3)).toEqual(["contact", "app", "listed_at"]);
    expect(doc.kind).toBe("program");
  });

  it("refuses a listing without exactly one delivery route", () => {
    const bad = [{}, { home_hub: "https://h", endpoint: "https://e" }, { email: "x" }];
    for (const contact of bad) {
      expect(() => buildIdentityListing({ name: "x", contact } as never, id.publicKey)).toThrow(TypeError);
    }
  });

  it("publishes the signed payload and returns the listing page", async () => {
    const { calls, fetch } = fakeFetch([Response.json({ ok: true }, { status: 201 })]);
    const url = await publishListing(id, { name: "Bot", contact: { home_hub: "https://h" } }, { directory: "https://d.example/", fetch });
    expect(url).toBe(`https://d.example/identities/${id.publicKey}`);
    expect(calls[0]!.url).toBe("https://d.example/api/identities");
    const { payload, sig } = JSON.parse(calls[0]!.init.body as string);
    expect(ed25519.verify(fromB64url(sig), new TextEncoder().encode(payload), Buffer.from(id.publicKey, "hex"))).toBe(true);
  });

  it("retries 429 and reports a refusal as the directory wrote it", async () => {
    const { calls, fetch } = fakeFetch([
      new Response(null, { status: 429 }),
      Response.json({ error: "Invalid tagline (160 characters or fewer)" }, { status: 400 }),
    ]);
    const err = await publishListing(id, { name: "Bot", contact: { home_hub: "https://h" } }, {
      directory: "https://d", fetch, retry: { baseDelayMs: 0 },
    }).catch((e) => e);
    expect(calls).toHaveLength(2);
    expect(err).toBeInstanceOf(DirectoryError);
    expect(err.reason).toBe("Invalid tagline (160 characters or fewer)");
  });

  it("signs the delete over the listed_at the directory holds", async () => {
    const { calls, fetch } = fakeFetch([Response.json({ listed_at: 42 }), Response.json({ ok: true })]);
    expect(await unpublishListing(id, { directory: "https://d", fetch })).toBe(true);
    const sig = (calls[1]!.init.headers as Record<string, string>)["x-wavvon-signature"]!;
    const msg = `wavvon-directory/delete/v1:identity:${id.publicKey}:42`;
    expect(calls[1]!.init.method).toBe("DELETE");
    expect(ed25519.verify(fromB64url(sig), new TextEncoder().encode(msg), Buffer.from(id.publicKey, "hex"))).toBe(true);
  });

  it("reports a missing listing as false", async () => {
    const { fetch } = fakeFetch([new Response(null, { status: 404 })]);
    expect(await unpublishListing(id, { directory: "https://d", fetch })).toBe(false);
  });
});
