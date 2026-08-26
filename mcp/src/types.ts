/** Type definitions mirroring the gridcarbon REST API, plus SDK-side enrichments. */

/** Upstream data provider for a zone. */
export type ZoneSource = "entsoe" | "eia" | "uk-neso";

/** A row from GET /v1/zones. */
export interface Zone {
  zone: string;
  name: string;
  source: ZoneSource;
  resolution_min: number;
}

export interface ZonesResponse {
  data: Zone[];
}

/** An item from GET /v1/intensity/latest -- carries its own zone field. */
export interface LatestItem {
  zone: string;
  ts: string;
  gco2eq_kwh: number;
  method: string;
}

export interface LatestResponse {
  unit: string;
  data: LatestItem[];
}

/**
 * An item from GET /v1/intensity -- note the asymmetry with LatestItem:
 * series items have NO zone field, the zone lives on the envelope.
 */
export interface SeriesItem {
  ts: string;
  gco2eq_kwh: number;
  method: string;
}

export interface SeriesResponse {
  zone: string;
  from: string;
  to: string;
  unit: string;
  count: number;
  truncated: boolean;
  note?: string;
  data: SeriesItem[];
}

/** The API's error body shape. */
export interface ApiErrorBody {
  error: string;
}

/** How stale a reading is relative to what is normal for its source. */
export type Freshness = "fresh" | "normal" | "stale" | "very_stale";

/**
 * One normalised reading. Every reading the SDK hands back has a zone and a
 * populated staleness block, regardless of which endpoint it came from.
 */
export interface Reading {
  zone: string;
  zone_name?: string;
  source?: ZoneSource;
  resolution_min?: number;
  ts: string;
  gco2eq_kwh: number;
  unit: string;
  method: string;
  age_minutes: number;
  age_human: string;
  freshness: Freshness;
  /** True when this zone uses operational (combustion-only) factors. */
  operational_factors_only: boolean;
  /** Present only when something about this reading could mislead the reader. */
  warning?: string;
}
