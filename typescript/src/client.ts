import {
  AbortError,
  ApiError,
  GridCarbonError,
  MalformedResponseError,
  NetworkError,
  TruncatedSeriesError,
  UnknownZoneError,
} from "./errors.js";
import type {
  GridCarbonOptions,
  IngestionStatus,
  Reading,
  RequestOptions,
  Series,
  SeriesOptions,
  TruncationBehaviour,
  Zone,
} from "./types.js";

/** Package version, also used in the default `User-Agent`. */
export const VERSION = "0.1.0";

/** Default API root. */
export const DEFAULT_BASE_URL = "https://api.gridcarbon.dev";

/** Default per-request timeout in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 10_000;

const DEFAULT_USER_AGENT = `gridcarbon-js/${VERSION} (+https://gridcarbon.dev)`;

/** The server's hard cap on points returned by one `/v1/intensity` call. */
export const SERIES_POINT_LIMIT = 5000;

interface RawZone {
  zone?: unknown;
  name?: unknown;
  source?: unknown;
  resolution_min?: unknown;
}

interface RawReading {
  zone?: unknown;
  ts?: unknown;
  gco2eq_kwh?: unknown;
  method?: unknown;
}

/**
 * A reading is comparable with the other lifecycle zones only when it was
 * computed by this API from IPCC AR5 lifecycle factors. GB's values are passed
 * through from NESO and use operational (combustion-only) factors, so anything
 * that is not `computed:*` is treated as non-lifecycle.
 */
function methodIsLifecycle(method: string): boolean {
  return method.startsWith("computed:");
}

function toIsoInstant(value: Date | string | number, label: string): string {
  const date =
    value instanceof Date
      ? value
      : typeof value === "number"
        ? new Date(value)
        : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new GridCarbonError(
      `Invalid ${label}: ${String(value)}. Pass a Date, an ISO-8601 string, or epoch milliseconds.`,
    );
  }
  return date.toISOString();
}

function parseTimestamp(raw: unknown, url: string): Date {
  if (typeof raw !== "string") {
    throw new MalformedResponseError(url, `reading has a non-string "ts" (${JSON.stringify(raw)})`);
  }
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw new MalformedResponseError(url, `reading has an unparseable "ts" (${raw})`);
  }
  return date;
}

function toReading(raw: RawReading, url: string, fallbackZone?: string): Reading {
  const zone = typeof raw.zone === "string" && raw.zone ? raw.zone : fallbackZone;
  if (!zone) {
    throw new MalformedResponseError(url, `reading has no zone and none could be inferred`);
  }
  const value = raw.gco2eq_kwh;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new MalformedResponseError(
      url,
      `reading for ${zone} has a non-numeric "gco2eq_kwh" (${JSON.stringify(value)})`,
    );
  }
  const method = typeof raw.method === "string" ? raw.method : "";
  return {
    zone,
    ts: parseTimestamp(raw.ts, url),
    gco2eqPerKwh: value,
    method,
    isLifecycle: methodIsLifecycle(method),
  };
}

function isAbortLike(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    ((err as { name?: unknown }).name === "AbortError" ||
      (err as { name?: unknown }).name === "TimeoutError")
  );
}

/**
 * Client for the gridcarbon.dev API.
 *
 * ```ts
 * const gc = new GridCarbon();
 * const de = await gc.latest("DE");
 * console.log(de.gco2eqPerKwh, de.ts.toISOString());
 * ```
 *
 * The client is stateless and safe to share; construct one per process.
 */
export class GridCarbon {
  /** Resolved API root, without a trailing slash. */
  readonly baseUrl: string;
  /** Resolved per-request timeout in milliseconds. `0` means no timeout. */
  readonly timeoutMs: number;
  /** Resolved `User-Agent` header value. */
  readonly userAgent: string;
  /** Resolved truncation behaviour for `series()`. */
  readonly onTruncated: TruncationBehaviour;

  readonly #fetch: typeof globalThis.fetch | undefined;

  constructor(options: GridCarbonOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.onTruncated = options.onTruncated ?? "warn";
    this.#fetch = options.fetch;
  }

  /**
   * All supported zones, sorted by zone code.
   *
   * @example
   * ```ts
   * const zones = await gc.zones();
   * zones.filter((z) => !z.isLifecycle); // -> [ { zone: "GB", ... } ]
   * ```
   */
  /**
   * Report whether ingestion is current, per upstream source.
   *
   * `health()` only tells you the API answered. This tells you whether the
   * numbers it would answer with are fresh, which is the question that
   * actually matters before acting on a value.
   */
  async status(options: RequestOptions = {}): Promise<IngestionStatus> {
    const { body, url } = await this.#request("/v1/status", {}, options);
    const d = body as {
      ok?: unknown;
      ts?: unknown;
      note?: unknown;
      sources?: unknown;
    };
    if (typeof d.ts !== "string") {
      throw new MalformedResponseError(url, `expected "ts" to be a string`);
    }
    const rawSources = Array.isArray(d.sources) ? d.sources : [];
    return {
      ok: d.ok === true,
      ts: new Date(d.ts),
      note: typeof d.note === "string" ? d.note : "",
      sources: rawSources.map((raw) => {
        const r = raw as Record<string, unknown>;
        const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
        return {
          source: typeof r.source === "string" ? r.source : "",
          zones: num(r.zones),
          freshestLagHours: num(r.freshest_lag_hours),
          stalestLagHours: num(r.stalest_lag_hours),
          staleAfterHours: num(r.stale_after_hours),
          ok: r.ok === true,
        };
      }),
    };
  }

  async zones(options: RequestOptions = {}): Promise<Zone[]> {
    const { body, url } = await this.#request("/v1/zones", {}, options);
    const data = (body as { data?: unknown }).data;
    if (!Array.isArray(data)) {
      throw new MalformedResponseError(url, `expected "data" to be an array`);
    }
    return data.map((raw: RawZone) => {
      const zone = typeof raw.zone === "string" ? raw.zone : "";
      if (!zone) throw new MalformedResponseError(url, `zone entry has no "zone" code`);
      const source = typeof raw.source === "string" ? raw.source : "";
      return {
        zone,
        name: typeof raw.name === "string" ? raw.name : zone,
        source,
        resolutionMinutes:
          typeof raw.resolution_min === "number" && Number.isFinite(raw.resolution_min)
            ? raw.resolution_min
            : 60,
        // GB is the one zone served straight from an upstream that publishes
        // operational rather than lifecycle factors.
        isLifecycle: source !== "uk-neso",
      };
    });
  }

  /** The newest published reading for every zone. */
  async latest(): Promise<Reading[]>;
  /** The newest published reading for one zone. Throws {@link UnknownZoneError} if the code is unknown. */
  async latest(zone: string, options?: RequestOptions): Promise<Reading>;
  async latest(zone?: string, options: RequestOptions = {}): Promise<Reading | Reading[]> {
    if (zone !== undefined && (typeof zone !== "string" || zone.trim() === "")) {
      throw new GridCarbonError(`zone must be a non-empty string, got ${JSON.stringify(zone)}`);
    }
    const code = zone?.trim().toUpperCase();
    const { body, url } = await this.#request(
      "/v1/intensity/latest",
      code ? { zone: code } : {},
      options,
    );
    const data = (body as { data?: unknown }).data;
    if (!Array.isArray(data)) {
      throw new MalformedResponseError(url, `expected "data" to be an array`);
    }
    const readings = data.map((raw: RawReading) => toReading(raw, url, code));
    if (code === undefined) return readings;
    const first = readings[0];
    if (!first) {
      // The live API 404s on an empty zone, but a cache or proxy could hand us
      // a 200 with an empty array; treat it the same way rather than returning
      // undefined behind a non-optional return type.
      throw new UnknownZoneError(code, undefined, url);
    }
    return first;
  }

  /**
   * A time series for one zone over a half-open `[start, end)` window.
   * Defaults to the last 24 hours.
   *
   * The server caps the result at {@link SERIES_POINT_LIMIT} points. When that
   * happens `truncated` is `true` and, by default, one `console.warn` is
   * emitted - configure `onTruncated` to throw instead.
   *
   * An unknown zone yields an empty `readings` array rather than an error: the
   * API answers 200 with no data, exactly as it does for a known zone with an
   * empty window.
   */
  async series(zone: string, options: SeriesOptions = {}): Promise<Series> {
    if (typeof zone !== "string" || zone.trim() === "") {
      throw new GridCarbonError(`zone must be a non-empty string, got ${JSON.stringify(zone)}`);
    }
    const code = zone.trim().toUpperCase();
    const params: Record<string, string> = { zone: code };
    if (options.start !== undefined) params["from"] = toIsoInstant(options.start, "start");
    if (options.end !== undefined) params["to"] = toIsoInstant(options.end, "end");

    const { body, url } = await this.#request("/v1/intensity", params, options);
    const envelope = body as {
      zone?: unknown;
      from?: unknown;
      to?: unknown;
      count?: unknown;
      truncated?: unknown;
      note?: unknown;
      data?: unknown;
    };
    const data = envelope.data;
    if (!Array.isArray(data)) {
      throw new MalformedResponseError(url, `expected "data" to be an array`);
    }
    const envelopeZone = typeof envelope.zone === "string" && envelope.zone ? envelope.zone : code;
    const readings = data.map((raw: RawReading) => toReading(raw, url, envelopeZone));
    const truncated = envelope.truncated === true;

    const series: Series = {
      zone: envelopeZone,
      start: parseWindowBound(envelope.from, params["from"], readings[0]?.ts),
      end: parseWindowBound(envelope.to, params["to"], readings[readings.length - 1]?.ts),
      readings,
      count: readings.length,
      truncated,
    };
    if (typeof envelope.note === "string" && envelope.note) series.note = envelope.note;

    if (truncated) {
      const behaviour = options.onTruncated ?? this.onTruncated;
      const message =
        `gridcarbon: series for ${envelopeZone} was TRUNCATED at ${readings.length} points - ` +
        `you are holding an incomplete window, so totals and averages over it will be wrong. ` +
        (series.note ?? `Narrow the window with start/end and page through it.`);
      if (behaviour === "throw") throw new TruncatedSeriesError(message, series);
      if (behaviour === "warn") {
        // eslint-disable-next-line no-console
        globalThis.console?.warn?.(message);
      }
    }
    return series;
  }

  async #request(
    path: string,
    params: Record<string, string>,
    options: RequestOptions,
  ): Promise<{ body: unknown; url: string }> {
    const url = buildUrl(this.baseUrl, path, params);
    const doFetch = this.#resolveFetch();

    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (this.timeoutMs > 0 && Number.isFinite(this.timeoutMs)) {
      // Deliberately NOT unref'd: an unref'd timer lets a Node process exit
      // while a request is still pending, so the timeout would silently never
      // fire. The timer is cleared in `finally`, so it never delays exit.
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, this.timeoutMs);
    }

    const external = options.signal;
    const onExternalAbort = () => controller.abort();
    if (external) {
      if (external.aborted) controller.abort();
      else external.addEventListener("abort", onExternalAbort, { once: true });
    }

    let response: Response;
    let text: string;
    try {
      response = await doFetch(url, {
        method: "GET",
        headers: {
          accept: "application/json",
          "user-agent": this.userAgent,
        },
        signal: controller.signal,
        redirect: "follow",
      });
      text = await response.text();
    } catch (err) {
      if (isAbortLike(err) || controller.signal.aborted) {
        throw timedOut
          ? new AbortError(`Request to ${url} timed out after ${this.timeoutMs} ms`, this.timeoutMs)
          : new AbortError(`Request to ${url} was aborted`);
      }
      throw new NetworkError(url, err);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      external?.removeEventListener("abort", onExternalAbort);
    }

    let body: unknown;
    let parsed = false;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
        parsed = true;
      } catch {
        parsed = false;
      }
    }

    if (!response.ok) {
      const serverMessage =
        parsed && typeof (body as { error?: unknown } | undefined)?.error === "string"
          ? ((body as { error: string }).error)
          : text.slice(0, 200) || undefined;
      const zoneMatch =
        response.status === 404 && serverMessage
          ? /unknown or empty zone:\s*(\S+)/i.exec(serverMessage)
          : null;
      if (zoneMatch) {
        throw new UnknownZoneError(zoneMatch[1] ?? params["zone"] ?? "", serverMessage, url);
      }
      throw new ApiError(response.status, serverMessage, url);
    }

    if (!parsed || typeof body !== "object" || body === null) {
      throw new MalformedResponseError(
        url,
        text.length === 0 ? "empty body" : `not a JSON object (${text.slice(0, 120)})`,
      );
    }
    return { body, url };
  }

  #resolveFetch(): typeof globalThis.fetch {
    if (this.#fetch) return this.#fetch;
    const globalFetch = globalThis.fetch;
    if (typeof globalFetch !== "function") {
      throw new GridCarbonError(
        "No global fetch found. Use Node 18+, a modern browser, Deno, Bun or Cloudflare Workers, " +
          "or pass your own implementation: new GridCarbon({ fetch }).",
      );
    }
    // Browsers require fetch to be called with `window` as the receiver.
    return globalFetch.bind(globalThis);
  }
}

function buildUrl(baseUrl: string, path: string, params: Record<string, string>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, value);
  }
  const qs = query.toString();
  return `${baseUrl}${path}${qs ? `?${qs}` : ""}`;
}

/**
 * Prefer the window the server echoed back, fall back to what we asked for, and
 * finally to the data itself. Only a server that echoes garbage and returns no
 * rows can produce an Invalid Date here.
 */
function parseWindowBound(
  echoed: unknown,
  requested: string | undefined,
  observed: Date | undefined,
): Date {
  for (const candidate of [echoed, requested]) {
    if (typeof candidate === "string") {
      const date = new Date(candidate);
      if (!Number.isNaN(date.getTime())) return date;
    }
  }
  return observed ?? new Date(Number.NaN);
}
