/**
 * Normalisation and presentation helpers.
 *
 * Everything the server hands back goes through here, so that staleness and the
 * Great Britain comparability caveat can never be accidentally omitted.
 */

import {
  EXPECTED_LAG_HOURS,
  GB_CAVEAT_SHORT,
  OPERATIONAL_FACTOR_ZONES,
  UNIT,
} from "./constants.js";
import { GridCarbonError } from "./api.js";
import type { Freshness, Reading, Zone } from "./types.js";

/** True when this zone's numbers use operational (combustion-only) factors. */
export function usesOperationalFactors(zone: string): boolean {
  return OPERATIONAL_FACTOR_ZONES.has(zone.toUpperCase());
}

/** "2h 14m ago" / "in 30m" / "just now". */
export function humaniseAge(minutes: number): string {
  const rounded = Math.round(minutes);
  if (rounded < 0) {
    const ahead = Math.abs(rounded);
    return ahead < 60
      ? `${ahead}m in the future (forecast interval)`
      : `${Math.floor(ahead / 60)}h ${ahead % 60}m in the future (forecast interval)`;
  }
  if (rounded < 1) return "just now";
  if (rounded < 60) return `${rounded}m ago`;
  const hours = Math.floor(rounded / 60);
  const mins = rounded % 60;
  if (hours < 48) return `${hours}h ${mins}m ago`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h ago`;
}

/**
 * Classify staleness relative to what is normal for the zone's source.
 * EIA zones are routinely a day behind; that is "normal", not "broken".
 */
export function classifyFreshness(
  ageMinutes: number,
  source: string | undefined,
): Freshness {
  const expectedHours =
    source !== undefined ? (EXPECTED_LAG_HOURS[source] ?? 4) : 4;
  const expectedMinutes = expectedHours * 60;
  if (ageMinutes <= 60) return "fresh";
  if (ageMinutes <= expectedMinutes) return "normal";
  if (ageMinutes <= expectedMinutes * 2) return "stale";
  return "very_stale";
}

/**
 * Turn a raw API item into a Reading. This is the single place where the
 * envelope/item asymmetry between /latest and /intensity is reconciled: the
 * caller passes the zone explicitly, so every Reading has one.
 */
export function toReading(
  zone: string,
  item: { ts: string; gco2eq_kwh: number; method: string },
  zoneMeta: Zone | undefined,
  now: Date = new Date(),
): Reading {
  const ageMinutes = Math.round(
    (now.getTime() - new Date(item.ts).getTime()) / 60_000,
  );
  const freshness = classifyFreshness(ageMinutes, zoneMeta?.source);
  const operational = usesOperationalFactors(zone);

  const warnings: string[] = [];
  if (operational) warnings.push(GB_CAVEAT_SHORT);
  if (freshness === "stale" || freshness === "very_stale") {
    warnings.push(
      `This observation is ${humaniseAge(ageMinutes)}, later than the usual lag for ` +
        `${zoneMeta?.source ?? "this source"}. Report it as of ${item.ts}, not as "now".`,
    );
  }
  if (item.method === "upstream:uk-neso:forecast") {
    warnings.push(
      "method is 'upstream:uk-neso:forecast' -- this interval is a NESO forecast, " +
        "not a settled actual. It may be revised.",
    );
  }

  return {
    zone,
    ...(zoneMeta?.name ? { zone_name: zoneMeta.name } : {}),
    ...(zoneMeta?.source ? { source: zoneMeta.source } : {}),
    ...(zoneMeta?.resolution_min
      ? { resolution_min: zoneMeta.resolution_min }
      : {}),
    ts: item.ts,
    gco2eq_kwh: item.gco2eq_kwh,
    unit: UNIT,
    method: item.method,
    age_minutes: ageMinutes,
    age_human: humaniseAge(ageMinutes),
    freshness,
    operational_factors_only: operational,
    ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
  };
}

/** Plain-language band for a lifecycle-factor value. Never applied to GB. */
export function intensityBand(value: number): string {
  if (value < 100) return "very clean";
  if (value < 200) return "clean";
  if (value < 300) return "moderate";
  if (value < 450) return "fossil-heavy";
  return "very fossil-heavy";
}

/**
 * Resolve user input to a canonical zone code.
 * Accepts "de", "DE", "us_ercot", "US-ERCOT", and unambiguous names ("Texas").
 * Throws a GridCarbonError with concrete suggestions when it cannot.
 */
export function resolveZoneCode(input: string, zones: Zone[]): string {
  const raw = input.trim();
  const normalised = raw.toUpperCase().replace(/[_\s]+/g, "-");

  const exact = zones.find((z) => z.zone.toUpperCase() === normalised);
  if (exact) return exact.zone;

  const needle = raw.toLowerCase();
  const byName = zones.filter((z) => z.name.toLowerCase().includes(needle));
  if (byName.length === 1 && needle.length >= 3) return byName[0]!.zone;

  const suggestions = zones
    .filter(
      (z) =>
        z.zone.toUpperCase().startsWith(normalised.slice(0, 2)) ||
        (needle.length >= 3 && z.name.toLowerCase().includes(needle)),
    )
    .slice(0, 8)
    .map((z) => `${z.zone} (${z.name})`);

  throw new GridCarbonError(
    `Unknown zone "${raw}". Zone codes look like "DE", "FR", "US-ERCOT", "IT-NORD" ` +
      `(matching is case-insensitive, and "_" is accepted for "-").` +
      (suggestions.length > 0
        ? ` Did you mean: ${suggestions.join(", ")}?`
        : "") +
      ` Call list_zones for the full set of 45 covered zones. Do not substitute a ` +
      `neighbouring country's value for one that is not covered.`,
    404,
  );
}

/** ISO-8601 UTC string with second precision, no milliseconds. */
export function isoUtc(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}

/** Render a Reading as one markdown block. */
export function readingToMarkdown(reading: Reading): string {
  const lines: string[] = [];
  const label = reading.zone_name
    ? `${reading.zone} — ${reading.zone_name}`
    : reading.zone;
  lines.push(`## ${label}`);
  lines.push(
    `**${reading.gco2eq_kwh} ${reading.unit}**` +
      (reading.operational_factors_only
        ? " (operational factors — see warning)"
        : ` (${intensityBand(reading.gco2eq_kwh)})`),
  );
  lines.push(
    `- Interval start (UTC): \`${reading.ts}\`` +
      (reading.resolution_min ? ` (${reading.resolution_min}-minute interval)` : ""),
  );
  lines.push(`- Age: ${reading.age_human} (${reading.age_minutes} min, ${reading.freshness})`);
  lines.push(`- Method: \`${reading.method}\`${reading.source ? ` · source: ${reading.source}` : ""}`);
  if (reading.warning) lines.push(`- ⚠️ ${reading.warning}`);
  return lines.join("\n");
}

/** Build the standard MCP tool result for a successful call. */
export function ok(
  text: string,
  structuredContent: Record<string, unknown>,
): {
  content: { type: "text"; text: string }[];
  structuredContent: Record<string, unknown>;
} {
  return { content: [{ type: "text", text }], structuredContent };
}

/** Build the standard MCP tool result for a failure. */
export function fail(error: unknown): {
  content: { type: "text"; text: string }[];
  isError: true;
} {
  const message =
    error instanceof GridCarbonError
      ? error.message
      : error instanceof Error
        ? `Unexpected error: ${error.message}`
        : `Unexpected error: ${String(error)}`;
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

/** "2026-08-26 01:00 UTC" */
export function prettyTs(ts: string): string {
  return `${ts.slice(0, 10)} ${ts.slice(11, 16)} UTC`;
}

/**
 * A ready-made sentence stating the value together with its as-of time.
 * Written so that a model can quote it without accidentally implying "now".
 */
export function asOfStatement(reading: Reading): string {
  const label = !reading.zone_name
    ? reading.zone
    : reading.zone_name.includes("(")
      ? `${reading.zone} — ${reading.zone_name}`
      : `${reading.zone} (${reading.zone_name})`;
  const base =
    `As of ${prettyTs(reading.ts)} — the most recent published interval, ` +
    `${reading.age_human} — the carbon intensity of ${label} was ` +
    `${reading.gco2eq_kwh} ${reading.unit}.`;
  return reading.operational_factors_only
    ? `${base} This is an operational (combustion-only) figure and is not comparable with the other zones.`
    : base;
}
