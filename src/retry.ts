import { HubUnavailableError, WavvonError } from "./errors.js";

export interface RetryOptions {
  /** Attempts before giving up with HubUnavailableError. Infinity keeps trying. Default 8. */
  maxAttempts?: number;
  /** First backoff ceiling. Default 500 ms. */
  baseDelayMs?: number;
  /** Backoff ceiling never grows past this. Default 30 s. */
  maxDelayMs?: number;
  /** Per-attempt timeout; a timeout counts as transient. Default 15 s. */
  timeoutMs?: number;
  /** Called before each wait, so a program can show that it is retrying. */
  onRetry?: (info: RetryInfo) => void;
}

export interface RetryInfo {
  attempt: number;
  delayMs: number;
  /** HTTP status, or undefined for a network error or timeout. */
  status?: number;
  error?: unknown;
}

/** Test seams; production uses real time and Math.random. */
export interface RetryDeps {
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

/** 429 is "not now"; 5xx is the hub or a proxy in front of it failing. */
export const isTransientStatus = (status: number): boolean => status === 429 || status >= 500;

/** Full jitter: uniform in [0, min(max, base * 2^(attempt-1))]. */
export function backoffDelay(attempt: number, opts: RetryOptions = {}, random = Math.random): number {
  const base = opts.baseDelayMs ?? 500;
  const max = opts.maxDelayMs ?? 30_000;
  return Math.floor(random() * Math.min(max, base * 2 ** (attempt - 1)));
}

/**
 * A thrown error worth another attempt: fetch rejects with a TypeError on a
 * network failure, and our per-attempt timeout aborts with "TimeoutError".
 * Anything else (an SDK error such as AuthSchemeError, a bug) is rethrown.
 */
export function isTransientError(e: unknown): boolean {
  if (e instanceof WavvonError) return false;
  // ponytail: a programming TypeError also looks like a network failure; fetch gives nothing finer.
  if (e instanceof TypeError) return true;
  return (e as { name?: unknown } | null)?.name === "TimeoutError";
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Runs `attempt` until it yields a non-transient Response. The hub sends no
 * Retry-After, so the wait is capped exponential backoff with jitter. When the
 * budget runs out this throws HubUnavailableError rather than handing back the
 * last 429/5xx: a transient failure must never be mistaken for an answer.
 *
 * `attempt` may make several requests (login does) and return whichever
 * response decides the outcome.
 */
export async function fetchWithRetry(
  attempt: (signal: AbortSignal) => Promise<Response>,
  opts: RetryOptions = {},
  deps: RetryDeps = {},
): Promise<Response> {
  const maxAttempts = opts.maxAttempts ?? 8;
  const sleep = deps.sleep ?? realSleep;
  let lastStatus: number | undefined;
  let lastError: unknown;
  for (let n = 1; ; n++) {
    let status: number | undefined;
    let error: unknown;
    try {
      const res = await attempt(AbortSignal.timeout(opts.timeoutMs ?? 15_000));
      if (!isTransientStatus(res.status)) return res;
      status = res.status;
      await res.body?.cancel().catch(() => {});
    } catch (e) {
      if (!isTransientError(e)) throw e;
      error = e;
    }
    lastStatus = status;
    lastError = error;
    if (n >= maxAttempts) break;
    const delayMs = backoffDelay(n, opts, deps.random);
    opts.onRetry?.({ attempt: n, delayMs, status, error });
    await sleep(delayMs);
  }
  throw new HubUnavailableError(
    lastStatus !== undefined
      ? `hub kept answering ${lastStatus} after ${maxAttempts} attempts`
      : `hub unreachable after ${maxAttempts} attempts`,
    lastStatus,
    { cause: lastError },
  );
}
