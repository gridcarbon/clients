/** Thin HTTP client for the gridcarbon REST API. Uses built-in fetch only. */

import {
  API_BASE_URL,
  REQUEST_TIMEOUT_MS,
  USER_AGENT,
} from "./constants.js";
import type {
  ApiErrorBody,
  LatestResponse,
  SeriesResponse,
  Zone,
  ZonesResponse,
} from "./types.js";

/** An error carrying a message that is safe and useful to show an agent. */
export class GridCarbonError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "GridCarbonError";
    this.status = status;
  }
}

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { error?: unknown }).error === "string"
  );
}

async function request<T>(
  path: string,
  params?: Record<string, string | undefined>,
): Promise<T> {
  const url = new URL(`${API_BASE_URL}${path}`);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined) url.searchParams.set(key, value);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json", "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new GridCarbonError(
        `Timed out after ${REQUEST_TIMEOUT_MS / 1000}s waiting for ${url.origin}. ` +
          "The API may be briefly unavailable; retry once before telling the user it is down.",
      );
    }
    throw new GridCarbonError(
      `Could not reach the gridcarbon API at ${url.origin} (${cause}). ` +
        "Check network connectivity. Do not guess or invent carbon intensity values.",
    );
  }

  const text = await response.text();
  let body: unknown;
  try {
    body = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }

  if (!response.ok) {
    const detail = isApiErrorBody(body) ? body.error : `HTTP ${response.status}`;
    throw new GridCarbonError(detail, response.status);
  }

  if (body === undefined) {
    throw new GridCarbonError(
      `The API returned a non-JSON body for ${url.pathname} (HTTP ${response.status}).`,
    );
  }

  return body as T;
}

let zoneCache: { zones: Zone[]; fetchedAt: number } | undefined;
const ZONE_CACHE_TTL_MS = 10 * 60 * 1000;

/** GET /v1/zones, memoised for 10 minutes (the list changes very rarely). */
export async function fetchZones(): Promise<Zone[]> {
  if (zoneCache && Date.now() - zoneCache.fetchedAt < ZONE_CACHE_TTL_MS) {
    return zoneCache.zones;
  }
  const body = await request<ZonesResponse>("/v1/zones");
  const zones = body.data ?? [];
  zoneCache = { zones, fetchedAt: Date.now() };
  return zones;
}

/** Zone code -> Zone, for annotating readings with name/source/resolution. */
export async function fetchZoneMap(): Promise<Map<string, Zone>> {
  const zones = await fetchZones();
  return new Map(zones.map((zone) => [zone.zone, zone]));
}

/** GET /v1/intensity/latest, optionally for a single zone. */
export async function fetchLatest(zone?: string): Promise<LatestResponse> {
  return request<LatestResponse>("/v1/intensity/latest", { zone });
}

/** GET /v1/intensity?zone=...&from=...&to=... -- half-open window [from, to). */
export async function fetchSeries(
  zone: string,
  from?: string,
  to?: string,
): Promise<SeriesResponse> {
  return request<SeriesResponse>("/v1/intensity", { zone, from, to });
}
