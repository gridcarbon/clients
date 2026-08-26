/** Upstream data provider for a zone. */
export type ZoneSource = "entsoe" | "eia" | "uk-neso";

/** A supported grid zone, as returned by {@link GridCarbon.zones}. */
export interface Zone {
  /** Zone code, e.g. `"DE"`, `"DK-1"`, `"US-CAL-CISO"`. */
  zone: string;
  /** Human-readable name, e.g. `"Germany-Luxembourg"`. */
  name: string;
  /** Which upstream published the underlying generation mix. */
  source: ZoneSource | (string & {});
  /** Publication cadence in minutes: 60 for most zones, 30 for GB. */
  resolutionMinutes: number;
  /**
   * `true` when this zone's numbers are computed from IPCC AR5 **lifecycle**
   * emission factors. `false` for GB, whose values come straight from NESO and
   * use **operational** (combustion-only) factors. Only compare zones that
   * agree on this flag.
   */
  isLifecycle: boolean;
}

/**
 * One carbon-intensity data point.
 *
 * The API puts `zone` on the item for `/intensity/latest` but on the envelope
 * for `/intensity`; this SDK normalises that away so `zone` is always set.
 */
export interface Reading {
  /** Zone code this reading belongs to. Always populated. */
  zone: string;
  /**
   * When the reading applies (UTC instant). This is the newest *published*
   * value, not "now" - European zones lag 2-4h, US zones 11-28h.
   */
  ts: Date;
  /** Carbon intensity in grams of CO2-equivalent per kilowatt-hour. */
  gco2eqPerKwh: number;
  /**
   * How the value was derived: `"computed:v1"` for the 44 lifecycle zones, or
   * `"upstream:uk-neso:actual"` / `"upstream:uk-neso:forecast"` for GB.
   */
  method: string;
  /**
   * `true` for lifecycle (IPCC AR5) values, `false` for GB's operational
   * (combustion-only) values. Filter on this before ranking or averaging
   * across zones.
   */
  isLifecycle: boolean;
}

/** A time series of readings for one zone, plus the truncation flag. */
export interface Series {
  /** Zone code the series was requested for. */
  zone: string;
  /** Inclusive start of the returned window. */
  start: Date;
  /** Exclusive end of the returned window - the window is half-open `[start, end)`. */
  end: Date;
  /** The data points, oldest first. Empty when the window has no data. */
  readings: Reading[];
  /** Number of readings returned. Equals `readings.length`. */
  count: number;
  /**
   * `true` when the server hit its 5000-point cap and `readings` is therefore
   * an incomplete prefix of the window. **Always check this** before computing
   * an average or a total over the series.
   */
  truncated: boolean;
  /** The server's human-readable explanation, present only when `truncated`. */
  note?: string;
}

/** How `series()` should react when the server truncates the result. */
export type TruncationBehaviour = "warn" | "throw" | "ignore";

/** Options accepted by the {@link GridCarbon} constructor. */
export interface GridCarbonOptions {
  /** API root. Defaults to `https://api.gridcarbon.dev`. */
  baseUrl?: string;
  /**
   * Custom fetch implementation. Defaults to the global `fetch`, resolved at
   * call time so test doubles installed on `globalThis` are picked up.
   */
  fetch?: typeof globalThis.fetch;
  /** Per-request timeout in milliseconds. Defaults to `10000`. `0` disables it. */
  timeoutMs?: number;
  /** `User-Agent` header. Browsers ignore this header; every other runtime sends it. */
  userAgent?: string;
  /**
   * What `series()` does when the server caps the result:
   * `"warn"` (default) logs one `console.warn`, `"throw"` raises
   * {@link TruncatedSeriesError}, `"ignore"` stays silent. `Series.truncated`
   * is set either way.
   */
  onTruncated?: TruncationBehaviour;
}

/** Options common to every request method. */
export interface RequestOptions {
  /** Abort the request early from your own controller. */
  signal?: AbortSignal;
}

/** Options for {@link GridCarbon.series}. */
export interface SeriesOptions extends RequestOptions {
  /** Start of the window, inclusive. `Date`, ISO-8601 string, or epoch ms. Defaults to 24h ago. */
  start?: Date | string | number;
  /** End of the window, exclusive. `Date`, ISO-8601 string, or epoch ms. Defaults to now. */
  end?: Date | string | number;
  /** Override the client-level truncation behaviour for this call. */
  onTruncated?: TruncationBehaviour;
}
