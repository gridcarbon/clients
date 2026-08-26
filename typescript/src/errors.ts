import type { Series } from "./types.js";

/**
 * Every error this SDK throws is a `GridCarbonError`, so a single `catch`
 * can separate "the SDK/API had a problem" from bugs in your own code.
 */
export class GridCarbonError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "GridCarbonError";
    // Keeps `instanceof` working even when a downstream bundler transpiles
    // these classes down to ES5 functions.
    Object.setPrototypeOf(this, new.target.prototype);
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/** The API answered, but with a non-2xx status. */
export class ApiError extends GridCarbonError {
  /** HTTP status code, e.g. `404`. */
  readonly status: number;
  /** The `error` string from the JSON body, when the server sent one. */
  readonly serverMessage: string | undefined;
  /** The request URL that produced this error. */
  readonly url: string;

  constructor(
    status: number,
    serverMessage: string | undefined,
    url: string,
    message?: string,
  ) {
    super(
      message ??
        `gridcarbon API returned HTTP ${status}` +
          (serverMessage ? `: ${serverMessage}` : "") +
          ` (${url})`,
    );
    this.name = "ApiError";
    this.status = status;
    this.serverMessage = serverMessage;
    this.url = url;
  }
}

/**
 * The zone code is not one the API knows about, or it has no data at all yet.
 * Call {@link GridCarbon.zones} for the current list.
 *
 * Note this can only be raised by `latest(zone)`. A `series()` call for an
 * unknown zone returns HTTP 200 with an empty `readings` array, exactly as it
 * does for a known zone with no data in the requested window - the API does not
 * distinguish the two cases, and neither can this SDK.
 */
export class UnknownZoneError extends ApiError {
  /** The zone code that was rejected. */
  readonly zone: string;

  constructor(zone: string, serverMessage: string | undefined, url: string) {
    super(
      404,
      serverMessage,
      url,
      `Unknown or empty zone: ${zone}. Call zones() for the list of supported zones.`,
    );
    this.name = "UnknownZoneError";
    this.zone = zone;
  }
}

/**
 * The request was aborted - either it exceeded `timeoutMs` or the caller's own
 * `AbortSignal` fired. `err.name` is `"AbortError"`, matching the platform.
 */
export class AbortError extends GridCarbonError {
  /** Set when the abort came from this client's timeout rather than the caller. */
  readonly timeoutMs: number | undefined;

  constructor(message: string, timeoutMs?: number) {
    super(message);
    this.name = "AbortError";
    this.timeoutMs = timeoutMs;
  }
}

/** The request never reached the API: DNS, TLS, offline, CORS, connection reset. */
export class NetworkError extends GridCarbonError {
  /** The request URL that could not be reached. */
  readonly url: string;

  constructor(url: string, cause: unknown) {
    super(
      `Network request to ${url} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      cause,
    );
    this.name = "NetworkError";
    this.url = url;
  }
}

/** The API replied 2xx but the body was not the shape this SDK expects. */
export class MalformedResponseError extends GridCarbonError {
  /** The request URL that produced the unusable body. */
  readonly url: string;

  constructor(url: string, detail: string) {
    super(`gridcarbon API returned an unexpected body from ${url}: ${detail}`);
    this.name = "MalformedResponseError";
    this.url = url;
  }
}

/**
 * Thrown by `series()` when the server capped the result **and** the client is
 * configured with `onTruncated: "throw"`. The partial data is still attached so
 * you can inspect it before deciding how to narrow the window.
 */
export class TruncatedSeriesError extends GridCarbonError {
  /** The partial series the server returned. `series.truncated` is always `true`. */
  readonly series: Series;

  constructor(message: string, series: Series) {
    super(message);
    this.name = "TruncatedSeriesError";
    this.series = series;
  }
}
