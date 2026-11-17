// Lists this program in a directory's invite directory, so people can find it
// and invite it to their hub. Run it again after changing the listing; pass
// --remove to take it down.
//
//   WAVVON_DIRECTORY=https://directory.example  WAVVON_SEED=<64 hex chars>  \
//   WAVVON_HUB=https://hub.example  node examples/publish-listing.mjs [--remove]
//
// Invitations go to the listing's contact route: here the hub the program
// lives on. A program running its own server can use { endpoint } instead.

import { identityFromSeed, publishListing, unpublishListing } from "@wavvon/sdk";

const identity = identityFromSeed(process.env.WAVVON_SEED);
const opts = { directory: process.env.WAVVON_DIRECTORY };

if (process.argv.includes("--remove")) {
  console.log((await unpublishListing(identity, opts)) ? "removed" : "there was no listing");
} else {
  const url = await publishListing(identity, {
    name: "Echo",
    tagline: "Repeats what you say",
    tags: ["utility"],
    languages: ["en"],
    contact: { home_hub: process.env.WAVVON_HUB },
    app: { commands: [{ name: "echo", description: "Repeat after me" }] },
  }, opts);
  console.log("listed at", url);
}
