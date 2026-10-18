import { WavvonError } from "./errors.js";

/** The hub clamps `limit` to this; asking for more would look like a short page. */
export const MAX_PAGE_SIZE = 500;

/**
 * Walks a keyset-paged list to exhaustion. The hub's dialect is a bare array
 * plus `limit` and `cursor`, where the cursor is the key of the previous
 * page's last row (`code` for invites, `public_key` for users, `id` for most
 * others). A page shorter than `limit` is the end; one page is not the list.
 *
 * `fetchPage` makes the request (so it can name the cursor parameter the
 * endpoint uses) and must throw on failure: an error must never read as an
 * empty page. Check the endpoint's capability (`list.cursor` or
 * `list.cursor.lists`) first; a hub without it ignores the cursor, which this
 * detects and reports rather than looping.
 */
export async function* paginate<T>(
  fetchPage: (cursor: string | undefined, limit: number) => Promise<T[]>,
  key: (item: T) => string,
  limit = 100,
): AsyncGenerator<T, void, undefined> {
  const size = Math.min(Math.max(1, Math.floor(limit)), MAX_PAGE_SIZE);
  let cursor: string | undefined;
  let previousFirst: string | undefined;
  for (;;) {
    const page = await fetchPage(cursor, size);
    const first = page[0];
    if (first !== undefined && cursor !== undefined && key(first) === previousFirst) {
      throw new WavvonError("the hub returned the same page twice: it does not honour the cursor on this endpoint");
    }
    yield* page;
    const last = page[page.length - 1];
    if (page.length < size || last === undefined) return;
    previousFirst = first === undefined ? undefined : key(first);
    cursor = key(last);
  }
}
