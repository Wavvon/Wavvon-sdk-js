import { sha256 } from "@noble/hashes/sha2.js";
import type { Identity } from "./auth.js";
import { bytesToHex, utf8 } from "./bytes.js";
import { WavvonError } from "./errors.js";
import { fetchWithRetry, type RetryOptions } from "./retry.js";

/**
 * Where a listing's invitations are delivered (invite-directory.md §3):
 * exactly one route, a home hub or an endpoint of the program's own.
 */
export type ListingContact = { home_hub: string; endpoint?: never } | { endpoint: string; home_hub?: never };

/** What the publisher writes in a `wavvon.identity` listing; the key is filled in from the identity. */
export interface IdentityListing {
  name: string;
  tagline?: string;
  /** Markdown, up to 8000 characters. */
  description?: string;
  /** A label the publisher chooses, never verified by anyone. Default "program". */
  kind?: "person" | "program";
  tags?: string[];
  languages?: string[];
  contact: ListingContact;
  app?: { commands?: { name: string; description: string }[]; mini_app?: boolean };
  /** Seconds. The directory keeps only the newest listing per key, so this must grow. Default: now. */
  listedAt?: number;
}

export interface DirectoryOptions {
  /** Base URL of the directory, e.g. `https://directory.example`. */
  directory: string;
  retry?: RetryOptions;
  fetch?: typeof fetch;
}

/** A definitive refusal from the directory (4xx other than 429), with the reason it gave. */
export class DirectoryError extends WavvonError {
  override name = "DirectoryError";
  constructor(
    readonly status: number,
    readonly reason: string,
  ) {
    super(`directory answered ${status}: ${reason}`);
  }
}

function checkContact(contact: unknown): void {
  const routes = typeof contact === "object" && contact !== null ? Object.keys(contact) : [];
  if (routes.length !== 1 || (routes[0] !== "home_hub" && routes[0] !== "endpoint")) {
    throw new TypeError("contact must carry exactly one of home_hub or endpoint");
  }
  const value = (contact as Record<string, unknown>)[routes[0]];
  if (typeof value !== "string" || value === "") throw new TypeError(`contact.${routes[0]} must be a URL`);
}

/**
 * The exact bytes a `wavvon.identity` listing signs and submits. Key order and
 * normalisation match the Wavvon clients' builder, so the same listing is the
 * same bytes whichever of them published it.
 */
export function buildIdentityListing(listing: IdentityListing, publicKeyHex: string): string {
  checkContact(listing.contact);
  const contact = listing.contact.home_hub !== undefined
    ? { home_hub: listing.contact.home_hub.replace(/\/+$/, "") }
    : { endpoint: listing.contact.endpoint };
  return JSON.stringify({
    format: "wavvon.identity",
    version: 1,
    pubkey: `ed25519:${publicKeyHex}`,
    name: listing.name.trim(),
    tagline: (listing.tagline ?? "").trim(),
    description: listing.description ?? "",
    kind: listing.kind ?? "program",
    tags: listing.tags ?? [],
    languages: listing.languages ?? [],
    contact,
    app: listing.app,
    listed_at: listing.listedAt ?? Math.floor(Date.now() / 1000),
  });
}

/** What a removal signs: it names the `listed_at` (or timestamp) of the listing it removes. */
export function directoryDeleteMessage(kind: "identity" | "client", id: string, listedAt: string | number): string {
  return `wavvon-directory/delete/v1:${kind}:${id}:${listedAt}`;
}

/** Ed25519 over the UTF-8 bytes, base64url without padding, as the directory reads it. */
export function signDirectoryMessage(identity: Identity, message: string): string {
  let bin = "";
  for (const b of identity.sign(utf8(message))) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const base = (o: DirectoryOptions) => o.directory.replace(/\/+$/, "");

async function send(url: string, init: RequestInit, o: DirectoryOptions): Promise<Response> {
  const doFetch = o.fetch ?? fetch;
  const res = await fetchWithRetry((signal) => doFetch(url, { ...init, signal }), o.retry);
  if (res.ok || res.status === 404) return res;
  const text = await res.text();
  let reason = text;
  try {
    reason = (JSON.parse(text) as { error?: string }).error ?? text;
  } catch {
    // Not JSON: keep the body as the directory wrote it.
  }
  throw new DirectoryError(res.status, reason);
}

/** POSTs a signed listing and returns the response body. */
export async function postSignedListing(
  path: "identities" | "clients",
  payload: string,
  identity: Identity,
  o: DirectoryOptions,
): Promise<Record<string, unknown>> {
  const res = await send(`${base(o)}/api/${path}`, {
    method: "POST",
    // No JSON content type: a plain-text POST is a simple request a browser sends without a preflight.
    body: JSON.stringify({ payload, sig: signDirectoryMessage(identity, payload) }),
  }, o);
  if (res.status === 404) throw new DirectoryError(404, "this directory has no /api/" + path);
  return (await res.json()) as Record<string, unknown>;
}

/**
 * Sends the signed delete for a listing at `/api/<path>/<id>`. Returns false
 * when the directory holds no such listing.
 */
export async function deleteSignedListing(
  path: "identities" | "clients",
  id: string,
  identity: Identity,
  o: DirectoryOptions,
): Promise<boolean> {
  const url = `${base(o)}/api/${path}/${id}`;
  const current = await send(url, {}, o);
  if (current.status === 404) return false;
  const { listed_at } = (await current.json()) as { listed_at: string | number };
  const kind = path === "identities" ? "identity" : "client";
  const sig = signDirectoryMessage(identity, directoryDeleteMessage(kind, id, listed_at));
  const res = await send(url, { method: "DELETE", headers: { "x-wavvon-signature": sig } }, o);
  return res.status !== 404;
}

/**
 * Publishes (or replaces) this identity's listing in the directory's invite
 * directory, signed with `identity`. Returns the listing's page URL.
 */
export async function publishListing(identity: Identity, listing: IdentityListing, o: DirectoryOptions): Promise<string> {
  await postSignedListing("identities", buildIdentityListing(listing, identity.publicKey), identity, o);
  return `${base(o)}/identities/${identity.publicKey}`;
}

/** Removes this identity's listing. Returns false if there was none. */
export function unpublishListing(identity: Identity, o: DirectoryOptions): Promise<boolean> {
  return deleteSignedListing("identities", identity.publicKey, identity, o);
}

/**
 * The exact bytes of a `.wavvonclient` listing: the document as written, with
 * `author_pubkey` set to the signing key. The directory keys a client listing
 * by the SHA-256 of these bytes, so the same file always gives the same id.
 */
export function buildClientListing(doc: Record<string, unknown>, publicKeyHex: string): string {
  if (doc.format !== "wavvon.client") throw new TypeError('a client listing has format "wavvon.client"');
  return JSON.stringify({ ...doc, author_pubkey: `ed25519:${publicKeyHex}` });
}

/** Publishes a `.wavvonclient` listing signed with `identity`. Returns the listing's page URL. */
export async function publishClientListing(
  identity: Identity,
  doc: Record<string, unknown>,
  o: DirectoryOptions,
): Promise<string> {
  const { id } = await postSignedListing("clients", buildClientListing(doc, identity.publicKey), identity, o);
  return `${base(o)}/clients/${String(id)}`;
}

/** Removes the client listing published from `doc`. Returns false if there was none. */
export function unpublishClientListing(
  identity: Identity,
  doc: Record<string, unknown>,
  o: DirectoryOptions,
): Promise<boolean> {
  const payload = buildClientListing(doc, identity.publicKey);
  return deleteSignedListing("clients", bytesToHex(sha256(utf8(payload))), identity, o);
}
