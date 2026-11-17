#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { identityFromSeed } from "./auth.js";
import {
  DirectoryError,
  publishClientListing,
  publishListing,
  unpublishClientListing,
  unpublishListing,
  type IdentityListing,
} from "./directory.js";

const USAGE = `usage: wavvon publish <file.json> [--remove] [--directory <url>] [--seed-file <path>]

Signs a .wavvonclient (format "wavvon.client") or invite-directory listing
(format "wavvon.identity") and posts it to a Wavvon directory; --remove sends
the signed delete instead. The key comes from WAVVON_SEED (64 hex chars) or
--seed-file and is never sent anywhere. The directory comes from --directory
or WAVVON_DIRECTORY.`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      remove: { type: "boolean" },
      directory: { type: "string" },
      "seed-file": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) return console.log(USAGE);
  const [command, file, ...extra] = positionals;
  if (command !== "publish" || !file || extra.length > 0) fail(USAGE);

  const directory = values.directory ?? process.env.WAVVON_DIRECTORY;
  if (!directory) fail("no directory: pass --directory <url> or set WAVVON_DIRECTORY");
  const seed = values["seed-file"] ? readFileSync(values["seed-file"], "utf8") : process.env.WAVVON_SEED;
  if (!seed) fail("no key: set WAVVON_SEED or pass --seed-file <path>");
  const identity = identityFromSeed(seed);
  const doc = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  const opts = { directory };

  if (doc.format === "wavvon.client") {
    if (values.remove) {
      console.log((await unpublishClientListing(identity, doc, opts)) ? "removed" : "not listed");
    } else {
      console.log(await publishClientListing(identity, doc, opts));
    }
  } else if (doc.format === "wavvon.identity") {
    if (values.remove) {
      console.log((await unpublishListing(identity, opts)) ? "removed" : "not listed");
    } else {
      // The file's listed_at is not read: a re-publish is always stamped now, so it is the newest.
      console.log(await publishListing(identity, doc as unknown as IdentityListing, opts));
    }
  } else {
    fail(`unknown format ${JSON.stringify(doc.format)}: expected "wavvon.client" or "wavvon.identity"`);
  }
}

main().catch((e: unknown) => {
  fail(e instanceof DirectoryError ? e.reason : e instanceof Error ? e.message : String(e));
});
