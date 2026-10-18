/** Base class: every error this SDK throws on purpose is one of these. */
export class WavvonError extends Error {
  override name = "WavvonError";
}

/** The hub does not advertise a capability the call needs. Never a version check. */
export class UnsupportedByHubError extends WavvonError {
  override name = "UnsupportedByHubError";
  constructor(readonly capability: string) {
    super(`this hub does not advertise the "${capability}" capability`);
  }
}

/**
 * The hub could not be reached or kept saying "not now" (429, 5xx, timeout,
 * network) until the retry budget ran out. This is not an answer: the request
 * may succeed later, and nothing about the resource can be concluded from it.
 */
export class HubUnavailableError extends WavvonError {
  override name = "HubUnavailableError";
  constructor(
    message: string,
    readonly lastStatus?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** A definitive refusal from the hub (4xx other than 429). */
export class HubError extends WavvonError {
  override name = "HubError";
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`hub answered ${status}: ${body}`);
  }
}

/** The challenge could not be answered safely (unknown scheme, wrong length). */
export class AuthSchemeError extends WavvonError {
  override name = "AuthSchemeError";
}

/** A webhook request failed verification; answer it with 401 and do nothing. */
export class WebhookVerificationError extends WavvonError {
  override name = "WebhookVerificationError";
}
