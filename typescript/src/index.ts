/**
 * `gridcarbon` - a tiny, zero-dependency client for the gridcarbon.dev grid
 * carbon intensity API.
 *
 * ```ts
 * import { GridCarbon } from "gridcarbon";
 *
 * const gc = new GridCarbon();
 * const de = await gc.latest("DE");
 * console.log(`${de.zone}: ${de.gco2eqPerKwh} gCO2eq/kWh at ${de.ts.toISOString()}`);
 * ```
 *
 * Two things to keep in mind, both documented in the README:
 * GB values use operational factors and are not comparable with the other 44
 * zones (`Reading.isLifecycle`), and `latest` means "newest published", not
 * "now" (always read `Reading.ts`).
 *
 * @packageDocumentation
 */

export {
  GridCarbon,
  VERSION,
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  SERIES_POINT_LIMIT,
} from "./client.js";

export {
  GridCarbonError,
  ApiError,
  UnknownZoneError,
  AbortError,
  NetworkError,
  MalformedResponseError,
  TruncatedSeriesError,
} from "./errors.js";

export type {
  GridCarbonOptions,
  IngestionStatus,
  Reading,
  RequestOptions,
  Series,
  SeriesOptions,
  SourceStatus,
  TruncationBehaviour,
  Zone,
  ZoneSource,
} from "./types.js";
