/** Shared constants for the gridcarbon MCP server. */

export const SERVER_NAME = "gridcarbon";
// Must equal the version in package.json. ci.yml asserts it: this constant is
// what the server reports in serverInfo and in the User-Agent we send upstream,
// and it silently drifted to 0.1.0 while the package shipped as 0.1.1.
export const SERVER_VERSION = "0.1.1";

/** Canonical API host. Override with GRIDCARBON_API_URL for local development. */
export const DEFAULT_API_BASE_URL = "https://api.gridcarbon.dev";

export const API_BASE_URL = (
  process.env.GRIDCARBON_API_URL ?? DEFAULT_API_BASE_URL
).replace(/\/+$/, "");

export const USER_AGENT = `gridcarbon-mcp/${SERVER_VERSION} (+https://gridcarbon.dev)`;

/** Request timeout in milliseconds. */
export const REQUEST_TIMEOUT_MS = 20_000;

/** Maximum characters in a single tool response before we trim the payload. */
export const CHARACTER_LIMIT = 25_000;

/** Earliest timestamp the backing store has any data for. */
export const HISTORY_STARTS_AT = "2026-08-21T00:00:00Z";

/** Edge-cache TTL on /v1/intensity/latest. Do not poll faster than this. */
export const LATEST_CACHE_TTL_MINUTES = 5;

/** The unit every value in this API is expressed in. */
export const UNIT = "gCO2eq/kWh";

/**
 * Zones whose numbers come from an upstream provider using OPERATIONAL
 * (combustion-only) emission factors rather than IPCC AR5 lifecycle factors.
 * Their values are systematically lower and are NOT comparable with the
 * lifecycle zones. Currently: Great Britain only.
 */
export const OPERATIONAL_FACTOR_ZONES = new Set(["GB"]);

export const GB_CAVEAT_SHORT =
  "GB values come from NESO and use OPERATIONAL (combustion-only) emission factors, " +
  "not the IPCC AR5 lifecycle factors used for the other 44 zones. GB numbers are " +
  "systematically lower and MUST NOT be compared or ranked against other zones.";

/**
 * Typical publication lag per upstream source, in hours. Used only to decide
 * whether an observation is unusually stale for its source -- never to adjust
 * or extrapolate a value.
 */
export const EXPECTED_LAG_HOURS: Record<string, number> = {
  entsoe: 4,
  "uk-neso": 2,
  eia: 28,
};

/** Shared text block appended to every data-returning tool description. */
export const DATA_CONTRACT_NOTE = `Data contract (read this before you report any number to a user):
  - Unit is ${UNIT} (grams of CO2-equivalent per kilowatt-hour of electricity consumed).
    LOWER IS CLEANER. There is no upper bound; roughly <100 is very clean, ~100-300 is
    moderate, >400 is fossil-heavy.
  - "ts" is the START of the reporting interval, in UTC (ISO-8601, "Z" suffix). A value
    with ts=2026-08-26T01:00:00Z and a 60-minute resolution covers 01:00-02:00 UTC.
  - "latest" means NEWEST PUBLISHED, NOT "now". European zones typically run 2-4 hours
    behind real time; US (EIA) zones run 11-28 hours behind. Every reading carries
    "age_minutes" and "age_human" -- state that age when you report the value. Saying
    "the current carbon intensity in Texas is X" about a 20-hour-old number is wrong.
  - ${GB_CAVEAT_SHORT}
  - Coverage starts ${HISTORY_STARTS_AT}; there is no data before that date.
  - Attribution is a licence condition. If you surface these values to an end user,
    credit: ENTSO-E Transparency Platform / U.S. Energy Information Administration (EIA)
    / NESO Carbon Intensity API. EIA does not endorse this service or any use of it.`;
