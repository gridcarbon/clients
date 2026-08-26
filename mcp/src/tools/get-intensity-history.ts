/** Tool: get_intensity_history -- an interval-by-interval series for one zone. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { fetchSeries, fetchZones, GridCarbonError } from "../api.js";
import {
  DATA_CONTRACT_NOTE,
  GB_CAVEAT_SHORT,
  HISTORY_STARTS_AT,
  UNIT,
} from "../constants.js";
import {
  fail,
  humaniseAge,
  isoUtc,
  ok,
  prettyTs,
  resolveZoneCode,
  usesOperationalFactors,
} from "../format.js";
import { ResponseFormat, ZoneParam } from "../schemas.js";

const ISO_HINT =
  "ISO-8601 UTC, e.g. '2026-08-25T18:00:00Z'. Local times and offsets are not accepted.";

const inputSchema = {
  zone: ZoneParam,
  from: z
    .string()
    .optional()
    .describe(
      `Window start, INCLUSIVE. ${ISO_HINT} Omit to use 'hours' or the default last 24h. ` +
        `Nothing exists before ${HISTORY_STARTS_AT}.`,
    ),
  to: z
    .string()
    .optional()
    .describe(
      `Window end, EXCLUSIVE — the window is half-open [from, to). ${ISO_HINT} ` +
        `Omit for "up to now".`,
    ),
  hours: z
    .number()
    .int()
    .min(1)
    .max(2160)
    .optional()
    .describe(
      "Convenience alternative to from/to: the last N hours ending now. Ignored if " +
        "'from' is given. Example: hours=48 for the last two days.",
    ),
  max_points: z
    .number()
    .int()
    .min(1)
    .max(2000)
    .default(200)
    .describe(
      "Cap on how many interval points are included in the response, to keep it " +
        "readable. If the window holds more, the MOST RECENT max_points are returned and " +
        "the response says how many were omitted. Summary statistics are always computed " +
        "over the WHOLE window, never over the trimmed subset.",
    ),
  include_points: z
    .boolean()
    .default(true)
    .describe(
      "Set false to get only the summary statistics (min/max/mean/cleanest/dirtiest) " +
        "without the individual intervals. Useful for long windows.",
    ),
  response_format: ResponseFormat,
};

const outputSchema = {
  zone: z.string(),
  zone_name: z.string().optional(),
  source: z.string().optional(),
  resolution_min: z.number().optional(),
  unit: z.string(),
  from: z.string(),
  to: z.string(),
  count: z.number().describe("Points the API returned for the window."),
  server_truncated: z
    .boolean()
    .describe("True if the API hit its 5000-point cap and the window is INCOMPLETE."),
  server_truncation_note: z.string().optional(),
  points_returned: z.number(),
  points_omitted_for_brevity: z.number(),
  summary: z
    .object({
      min: z.number(),
      max: z.number(),
      mean: z.number(),
      first: z.object({ ts: z.string(), gco2eq_kwh: z.number() }),
      last: z.object({ ts: z.string(), gco2eq_kwh: z.number() }),
      cleanest: z.object({ ts: z.string(), gco2eq_kwh: z.number() }),
      dirtiest: z.object({ ts: z.string(), gco2eq_kwh: z.number() }),
      change_from_first_to_last_pct: z.number(),
    })
    .optional(),
  points: z.array(
    z.object({
      ts: z.string(),
      gco2eq_kwh: z.number(),
      method: z.string(),
    }),
  ),
  operational_factors_only: z.boolean(),
  warnings: z.array(z.string()),
};

function parseIso(value: string, field: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new GridCarbonError(
      `Could not parse '${field}'="${value}". Use ISO-8601 UTC, e.g. ` +
        `"2026-08-25T18:00:00Z".`,
    );
  }
  return parsed;
}

export function registerGetIntensityHistory(server: McpServer): void {
  server.registerTool(
    "get_intensity_history",
    {
      title: "Get a carbon intensity time series for a zone",
      description: `Return the interval-by-interval carbon intensity history for ONE zone over a time window.

Use it for "how has the German grid varied today", "what was the cleanest hour in France
yesterday", "is Ireland's grid dirtier at breakfast than at midday".

${DATA_CONTRACT_NOTE}

Window semantics:
  - The window is HALF-OPEN: [from, to). A point at exactly 'to' is excluded.
  - Default window is the last 24 hours. 'hours' is a shorthand for that.
  - Every point's ts is the START of its interval, in UTC. Resolution is 60 minutes for
    all zones except GB, which is 30.
  - There is no data before ${HISTORY_STARTS_AT}, and none for intervals the upstream
    source has not published yet, so a window that reaches into the last few hours (or,
    for US zones, the last day) will simply have fewer points. Missing points are gaps,
    not zeros — never interpolate them.

Args:
  - zone (string, required): e.g. "DE", "FR", "US-CAISO", "GB".
  - from (string, optional): inclusive ISO-8601 UTC start.
  - to (string, optional): exclusive ISO-8601 UTC end.
  - hours (integer 1-2160, optional): last N hours ending now; ignored when 'from' is set.
  - max_points (integer, default 200): trim to the most recent N points for readability.
  - include_points (boolean, default true): false returns summary statistics only.
  - response_format ("markdown" | "json", default "markdown").

Returns (structured):
  {
    "zone": "DE", "zone_name": "Germany-Luxembourg", "source": "entsoe",
    "resolution_min": 60, "unit": "${UNIT}",
    "from": "2026-08-25T18:00:00Z", "to": "2026-08-26T00:00:00Z",
    "count": 6,                       // points the API returned for the window
    "server_truncated": false,        // TRUE means the window is INCOMPLETE, see below
    "points_returned": 6, "points_omitted_for_brevity": 0,
    "summary": { "min": 356.5, "max": 380.7, "mean": 363.6,
                 "first": {...}, "last": {...},
                 "cleanest": {"ts": "...", "gco2eq_kwh": 356.5},
                 "dirtiest": {"ts": "...", "gco2eq_kwh": 380.7},
                 "change_from_first_to_last_pct": -5.3 },
    "points": [ { "ts": "2026-08-25T18:00:00Z", "gco2eq_kwh": 380.7, "method": "computed:v1" } ],
    "operational_factors_only": false,
    "warnings": []
  }

Truncation — do not ignore this:
  The API caps a response at 5000 points. When it does, "server_truncated" is true and
  the series you received is only PART of the requested window. Never present a
  truncated series as a complete picture, and never compute a daily/weekly average from
  one. Narrow the window and call again instead.

Examples:
  - "Chart France's grid over the last two days" -> zone="FR", hours=48
  - "Cleanest hour in Spain yesterday" -> zone="ES", from/to spanning that UTC day,
    then read summary.cleanest
  - "Average intensity last week" -> hours=168, include_points=false
  - Don't use for: a single current value (get_carbon_intensity) or cross-zone ranking
    (compare_zones).

Errors:
  - Unknown zone -> error with near matches; call list_zones.
  - Unparseable from/to -> error naming the offending field.
  - Empty window -> a message saying no intervals were published in that range.`,
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ zone, from, to, hours, max_points, include_points, response_format }) => {
      try {
        const zones = await fetchZones();
        const code = resolveZoneCode(zone, zones);
        const meta = zones.find((z) => z.zone === code);

        let fromIso = from;
        let toIso = to;
        if (!fromIso && hours !== undefined) {
          const end = toIso ? parseIso(toIso, "to") : new Date();
          fromIso = isoUtc(new Date(end.getTime() - hours * 3_600_000));
          toIso = toIso ?? isoUtc(end);
        }
        if (fromIso) fromIso = isoUtc(parseIso(fromIso, "from"));
        if (toIso) toIso = isoUtc(parseIso(toIso, "to"));
        if (fromIso && toIso && new Date(fromIso) >= new Date(toIso)) {
          throw new GridCarbonError(
            `Empty window: from (${fromIso}) is not before to (${toIso}). The window is ` +
              `half-open [from, to), so from must be strictly earlier.`,
          );
        }

        const series = await fetchSeries(code, fromIso, toIso);
        const points = series.data ?? [];
        const operational = usesOperationalFactors(code);
        const warnings: string[] = [];

        if (series.truncated) {
          warnings.push(
            `INCOMPLETE SERIES: the API hit its 5000-point cap for this window, so these ` +
              `${points.length} points are only part of ${series.from} to ${series.to}. ` +
              (series.note ? `API note: ${series.note.replace(/[.\s]+$/, "")}. ` : "") +
              `Do not average or summarise this as if it covered the whole window — ` +
              `request a narrower window instead.`,
          );
        }
        if (operational) warnings.push(GB_CAVEAT_SHORT);
        if (fromIso && new Date(fromIso) < new Date(HISTORY_STARTS_AT)) {
          warnings.push(
            `The requested window starts before coverage began (${HISTORY_STARTS_AT}); ` +
              `no data exists for the earlier part of it.`,
          );
        }

        if (points.length === 0) {
          const text =
            `No intervals published for ${code} between ${series.from} and ${series.to}. ` +
            `Coverage starts ${HISTORY_STARTS_AT}, and the newest intervals lag real time ` +
            `(hours for Europe, up to a day for US zones), so the covered range is ` +
            `${HISTORY_STARTS_AT} up to a few hours ago. Move the window inside that range ` +
            `or widen it. Do not report a value for this period.`;
          return ok(text, {
            zone: code,
            ...(meta ? { zone_name: meta.name, source: meta.source, resolution_min: meta.resolution_min } : {}),
            unit: series.unit ?? UNIT,
            from: series.from,
            to: series.to,
            count: 0,
            server_truncated: Boolean(series.truncated),
            ...(series.note ? { server_truncation_note: series.note } : {}),
            points_returned: 0,
            points_omitted_for_brevity: 0,
            points: [],
            operational_factors_only: operational,
            warnings,
          });
        }

        const values = points.map((p) => p.gco2eq_kwh);
        const first = points[0]!;
        const last = points[points.length - 1]!;
        let cleanest = first;
        let dirtiest = first;
        for (const point of points) {
          if (point.gco2eq_kwh < cleanest.gco2eq_kwh) cleanest = point;
          if (point.gco2eq_kwh > dirtiest.gco2eq_kwh) dirtiest = point;
        }
        const mean = values.reduce((a, b) => a + b, 0) / values.length;
        const summary = {
          min: cleanest.gco2eq_kwh,
          max: dirtiest.gco2eq_kwh,
          mean: Math.round(mean * 10) / 10,
          first: { ts: first.ts, gco2eq_kwh: first.gco2eq_kwh },
          last: { ts: last.ts, gco2eq_kwh: last.gco2eq_kwh },
          cleanest: { ts: cleanest.ts, gco2eq_kwh: cleanest.gco2eq_kwh },
          dirtiest: { ts: dirtiest.ts, gco2eq_kwh: dirtiest.gco2eq_kwh },
          change_from_first_to_last_pct:
            first.gco2eq_kwh === 0
              ? 0
              : Math.round(
                  ((last.gco2eq_kwh - first.gco2eq_kwh) / first.gco2eq_kwh) * 1000,
                ) / 10,
        };

        const kept = include_points ? points.slice(-max_points) : [];
        const omitted = include_points ? points.length - kept.length : points.length;
        if (omitted > 0 && include_points) {
          warnings.push(
            `${omitted} earlier point(s) were omitted from "points" to keep the response ` +
              `readable (max_points=${max_points}); the summary statistics still cover all ` +
              `${points.length} points in the window.`,
          );
        }

        const lastAgeMinutes = Math.round(
          (Date.now() - new Date(last.ts).getTime()) / 60_000,
        );
        warnings.push(
          `The newest interval in this window starts ${last.ts} (${humaniseAge(lastAgeMinutes)}). ` +
            `That is the end of the published data, not the present moment.`,
        );

        const output = {
          zone: code,
          ...(meta
            ? { zone_name: meta.name, source: meta.source, resolution_min: meta.resolution_min }
            : {}),
          unit: series.unit ?? UNIT,
          from: series.from,
          to: series.to,
          count: points.length,
          server_truncated: Boolean(series.truncated),
          ...(series.note ? { server_truncation_note: series.note } : {}),
          points_returned: kept.length,
          points_omitted_for_brevity: include_points ? omitted : points.length,
          summary,
          points: kept,
          operational_factors_only: operational,
          warnings,
        };

        let text: string;
        if (response_format === "json") {
          text = JSON.stringify(output, null, 2);
        } else {
          const label = meta ? `${code} — ${meta.name}` : code;
          const lines = [
            `# ${label}: ${prettyTs(series.from)} → ${prettyTs(series.to)}`,
            "",
            `${points.length} interval(s), unit ${output.unit}, lower is cleaner.`,
            "",
            `- Mean **${summary.mean}**, min **${summary.min}**, max **${summary.max}**`,
            `- Cleanest interval: ${prettyTs(summary.cleanest.ts)} at ${summary.cleanest.gco2eq_kwh}`,
            `- Dirtiest interval: ${prettyTs(summary.dirtiest.ts)} at ${summary.dirtiest.gco2eq_kwh}`,
            `- First → last: ${summary.first.gco2eq_kwh} → ${summary.last.gco2eq_kwh} ` +
              `(${summary.change_from_first_to_last_pct > 0 ? "+" : ""}${summary.change_from_first_to_last_pct}%)`,
            "",
          ];
          if (kept.length > 0) {
            lines.push(
              `| Interval start (UTC) | ${output.unit} | method |`,
              "| :------------------- | ------------: | :----- |",
            );
            for (const point of kept) {
              lines.push(`| ${point.ts} | ${point.gco2eq_kwh} | ${point.method} |`);
            }
            lines.push("");
          }
          for (const warning of warnings) lines.push(`> ⚠️ ${warning}`);
          text = lines.join("\n");
        }

        return ok(text, output);
      } catch (error) {
        return fail(error);
      }
    },
  );
}
