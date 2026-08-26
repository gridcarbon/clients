/** Tool: compare_zones -- rank zones by their newest published carbon intensity. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { fetchLatest, fetchZones, GridCarbonError } from "../api.js";
import { DATA_CONTRACT_NOTE, GB_CAVEAT_SHORT, UNIT } from "../constants.js";
import {
  fail,
  humaniseAge,
  intensityBand,
  ok,
  prettyTs,
  resolveZoneCode,
  toReading,
  usesOperationalFactors,
} from "../format.js";
import { ReadingShape, ResponseFormat } from "../schemas.js";
import type { Reading } from "../types.js";

/** Age gap beyond which a cross-zone comparison is comparing different moments. */
const AGE_GAP_WARN_MINUTES = 6 * 60;

const inputSchema = {
  zones: z
    .array(z.string().min(1).max(32))
    .min(1)
    .max(45)
    .optional()
    .describe(
      "Zone codes to rank, e.g. [\"DE\",\"FR\",\"ES\"]. Omit to rank every covered zone " +
        "(use 'limit' to keep that readable). Unknown codes are reported back rather " +
        "than silently dropped.",
    ),
  order: z
    .enum(["cleanest_first", "dirtiest_first"])
    .default("cleanest_first")
    .describe(
      "Sort direction. 'cleanest_first' = ascending gCO2eq/kWh (lowest emissions first).",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(45)
    .default(45)
    .describe(
      "Maximum ranked rows to return. Mainly useful when ranking all zones, e.g. " +
        "limit=5 with order='cleanest_first' for the five cleanest grids.",
    ),
  include_gb_in_ranking: z
    .boolean()
    .default(false)
    .describe(
      "Great Britain uses operational (combustion-only) emission factors while the " +
        "other 44 zones use IPCC AR5 lifecycle factors, so GB's number is systematically " +
        "lower and ranking it against the others is misleading. By default GB is kept " +
        "OUT of the ranking and reported separately with its value and an explanation. " +
        "Set true only if the user has been told about the mismatch; GB is then ranked " +
        "but flagged as not comparable in every row and in a top-level warning.",
    ),
  response_format: ResponseFormat,
};

const RankedShape = {
  ...ReadingShape,
  rank: z.number(),
  band: z.string().optional(),
  comparable: z.boolean(),
};

const outputSchema = {
  unit: z.string(),
  order: z.string(),
  comparison_basis: z.string(),
  ranked_count: z.number(),
  omitted_by_limit: z
    .number()
    .describe(
      "Zones that had data and were ranked but were cut by 'limit'. When >0, every " +
        "figure in this response describes the returned rows only.",
    ),
  ranked: z.array(z.object(RankedShape)),
  cleanest: z.object(ReadingShape).optional(),
  dirtiest: z.object(ReadingShape).optional(),
  spread_gco2eq_kwh: z.number().optional(),
  excluded_from_ranking: z.array(
    z.object({
      zone: z.string(),
      zone_name: z.string().optional(),
      reason: z.string(),
      gco2eq_kwh: z.number().optional(),
      ts: z.string().optional(),
      age_human: z.string().optional(),
    }),
  ),
  observation_times: z.object({
    newest_ts: z.string().optional(),
    oldest_ts: z.string().optional(),
    age_gap_minutes: z.number().optional(),
  }),
  headline: z.string(),
  warnings: z.array(z.string()),
};

export function registerCompareZones(server: McpServer): void {
  server.registerTool(
    "compare_zones",
    {
      title: "Rank electricity zones by carbon intensity",
      description: `Rank several electricity zones (or all 45) by their most recently published carbon
intensity, cleanest first by default.

Use it for "where should I run this training job", "is Sweden cleaner than Poland right
now", "what are the five cleanest grids you cover".

${DATA_CONTRACT_NOTE}

Great Britain — the one thing that makes this tool easy to get wrong:
  GB's numbers come from NESO and use OPERATIONAL (combustion-only) factors. The other 44
  zones use IPCC AR5 LIFECYCLE factors, which also count plant construction and fuel
  supply chains. GB therefore looks cleaner than like-for-like. GB is EXCLUDED from the
  ranking by default and returned in "excluded_from_ranking" WITH its value and the
  reason, so you can still report it — just report it separately, never as "GB is the
  cleanest of these". Passing include_gb_in_ranking=true ranks it anyway and flags every
  affected row; only do that if the user has been told why the numbers differ.

Comparing different moments:
  Each zone's newest published interval has its own timestamp. European zones run 2-4h
  behind, US zones 11-28h behind, so a Europe-vs-US ranking compares observations taken
  up to a day apart. "observation_times.age_gap_minutes" reports that spread and a
  warning is added when it exceeds 6 hours. Say so when it applies.

Args:
  - zones (string[], optional): zone codes to rank. Omit to rank all covered zones.
  - order ("cleanest_first" | "dirtiest_first", default "cleanest_first").
  - limit (integer 1-45, default 45): cap on ranked rows.
  - include_gb_in_ranking (boolean, default false): see above.
  - response_format ("markdown" | "json", default "markdown").

Returns (structured):
  {
    "unit": "${UNIT}", "order": "cleanest_first",
    "comparison_basis": "IPCC AR5 lifecycle factors (GB excluded: operational factors)",
    "ranked_count": 3, "omitted_by_limit": 0,
    "ranked": [ { "rank": 1, "zone": "FR", "zone_name": "France",
                  "gco2eq_kwh": 48.3, "ts": "2026-08-26T00:00:00Z",
                  "age_minutes": 168, "age_human": "2h 48m ago", "freshness": "normal",
                  "band": "very clean", "comparable": true, "method": "computed:v1" } ],
    "cleanest": { ... }, "dirtiest": { ... }, "spread_gco2eq_kwh": 356.1,
    "excluded_from_ranking": [
      { "zone": "GB", "zone_name": "Great Britain", "gco2eq_kwh": 114,
        "ts": "2026-08-26T01:30:00Z", "age_human": "1h 18m ago",
        "reason": "GB uses operational (combustion-only) factors ... not comparable ..." }
    ],
    "observation_times": { "newest_ts": "...", "oldest_ts": "...", "age_gap_minutes": 90 },
    "headline": "Of 3 zone(s) ranked, FR is cleanest at 48.3 ${UNIT} ...",
    "warnings": [ ... ]
  }

Unknown zone codes are returned in "excluded_from_ranking" with reason "unknown zone
code" instead of failing the whole call — surface them to the user, do not substitute a
neighbour.

Examples:
  - "Germany, France or Spain — which is cleanest?" -> zones=["DE","FR","ES"]
  - "Five cleanest grids you cover" -> omit zones, limit=5
  - "Dirtiest US grid today" -> zones=["US-ERCOT","US-PJM","US-MISO","US-SPP","US-SOCO",
    "US-CAISO","US-ISONE","US-NYISO","US-BPA","US-TVA"], order="dirtiest_first", limit=1
  - Don't use for: one zone (get_carbon_intensity) or a time series (get_intensity_history).`,
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ zones, order, limit, include_gb_in_ranking, response_format }) => {
      try {
        const allZones = await fetchZones();
        const zoneMap = new Map(allZones.map((z) => [z.zone, z]));
        const excluded: {
          zone: string;
          zone_name?: string;
          reason: string;
          gco2eq_kwh?: number;
          ts?: string;
          age_human?: string;
        }[] = [];

        let wanted: string[];
        if (zones && zones.length > 0) {
          wanted = [];
          for (const input of zones) {
            try {
              const code = resolveZoneCode(input, allZones);
              if (!wanted.includes(code)) wanted.push(code);
            } catch (error) {
              excluded.push({
                zone: input,
                reason:
                  error instanceof GridCarbonError
                    ? `Unknown zone code. ${error.message}`
                    : `Unknown zone code "${input}".`,
              });
            }
          }
          if (wanted.length === 0) {
            throw new GridCarbonError(
              `None of the requested zones are covered: ${zones.join(", ")}. ` +
                `Call list_zones to see the 45 supported codes. Coverage is Europe ` +
                `(ENTSO-E), the United States (EIA) and Great Britain (NESO) only.`,
            );
          }
        } else {
          wanted = allZones.map((z) => z.zone);
        }

        const latest = await fetchLatest();
        const byZone = new Map(latest.data?.map((item) => [item.zone, item]) ?? []);
        const now = new Date();

        const readings: Reading[] = [];
        for (const code of wanted) {
          const item = byZone.get(code);
          if (!item) {
            excluded.push({
              zone: code,
              ...(zoneMap.get(code)?.name ? { zone_name: zoneMap.get(code)!.name } : {}),
              reason:
                "Covered, but the upstream source has not published any interval yet, " +
                "so there is no value to rank.",
            });
            continue;
          }
          readings.push(toReading(code, item, zoneMap.get(code), now));
        }

        const rankable: Reading[] = [];
        for (const reading of readings) {
          if (usesOperationalFactors(reading.zone) && !include_gb_in_ranking) {
            excluded.push({
              zone: reading.zone,
              ...(reading.zone_name ? { zone_name: reading.zone_name } : {}),
              gco2eq_kwh: reading.gco2eq_kwh,
              ts: reading.ts,
              age_human: reading.age_human,
              reason:
                `Not ranked: ${GB_CAVEAT_SHORT} Its value of ${reading.gco2eq_kwh} ` +
                `${UNIT} at ${reading.ts} is reported here so it is not lost, but placing ` +
                `it in the same ranking would misrepresent it as cleaner than it is on a ` +
                `like-for-like basis.`,
            });
            continue;
          }
          rankable.push(reading);
        }

        rankable.sort((a, b) =>
          order === "cleanest_first"
            ? a.gco2eq_kwh - b.gco2eq_kwh
            : b.gco2eq_kwh - a.gco2eq_kwh,
        );
        const limited = rankable.slice(0, limit);
        const omitted_by_limit = rankable.length - limited.length;

        const ranked = limited.map((reading, index) => ({
          ...reading,
          rank: index + 1,
          comparable: !reading.operational_factors_only,
          ...(reading.operational_factors_only
            ? {}
            : { band: intensityBand(reading.gco2eq_kwh) }),
        }));

        const warnings: string[] = [];
        const gbRanked = ranked.filter((r) => !r.comparable);
        if (gbRanked.length > 0) {
          warnings.push(
            `NOT A LIKE-FOR-LIKE RANKING: ${gbRanked
              .map((r) => r.zone)
              .join(", ")} appears in this ranking at the caller's request, but ` +
              `${GB_CAVEAT_SHORT} Any statement of the form "X is cleaner than GB" or ` +
              `"GB ranks Nth" derived from this table is unsound.`,
          );
        }
        if (excluded.some((e) => usesOperationalFactors(e.zone))) {
          const requested = zones !== undefined && zones.length > 0;
          warnings.push(
            `GB is ${requested ? "in the requested set" : "covered"} but is NOT in the ` +
              `ranking. Its value is in "excluded_from_ranking" — report it separately, ` +
              `with the reason.`,
          );
        }
        if (omitted_by_limit > 0) {
          warnings.push(
            `limit=${limit} kept only the ${limited.length} ` +
              `${order === "cleanest_first" ? "cleanest" : "dirtiest"} of ` +
              `${rankable.length} zones that have data; ${omitted_by_limit} further zone(s) ` +
              `were ranked but not returned. Every figure below — cleanest, dirtiest, ` +
              `spread, observation times — describes the returned rows only, not the ` +
              `full set.`,
          );
        }

        const ages: number[] = limited.map((r) => r.age_minutes);
        const observation_times: {
          newest_ts?: string;
          oldest_ts?: string;
          age_gap_minutes?: number;
        } = {};
        if (limited.length > 0) {
          const sortedByTs = [...limited].sort((a, b) => a.age_minutes - b.age_minutes);
          observation_times.newest_ts = sortedByTs[0]!.ts;
          observation_times.oldest_ts = sortedByTs[sortedByTs.length - 1]!.ts;
          const gap = Math.max(...ages) - Math.min(...ages);
          observation_times.age_gap_minutes = gap;
          if (gap > AGE_GAP_WARN_MINUTES) {
            warnings.push(
              `These zones were not observed at the same time: the newest reading is ` +
                `${humaniseAge(Math.min(...ages))} and the oldest is ` +
                `${humaniseAge(Math.max(...ages))} — a spread of ${Math.round(gap / 60)} ` +
                `hours. Grid mixes change hour to hour, so this is a comparison of each ` +
                `zone's latest published interval, not of a common moment. Say so.`,
            );
          }
        }
        const stale = limited.filter(
          (r) => r.freshness === "stale" || r.freshness === "very_stale",
        );
        if (stale.length > 0) {
          warnings.push(
            `Unusually stale for their source: ${stale
              .map((r) => `${r.zone} (${r.age_human})`)
              .join(", ")}.`,
          );
        }

        const cleanest =
          limited.length > 0
            ? [...limited].sort((a, b) => a.gco2eq_kwh - b.gco2eq_kwh)[0]
            : undefined;
        const dirtiest =
          limited.length > 0
            ? [...limited].sort((a, b) => b.gco2eq_kwh - a.gco2eq_kwh)[0]
            : undefined;

        const headline =
          ranked.length === 0
            ? "No zones could be ranked. See excluded_from_ranking."
            : `Of ${ranked.length} zone(s) ranked, ${cleanest!.zone}` +
              `${cleanest!.zone_name ? ` (${cleanest!.zone_name})` : ""} is cleanest at ` +
              `${cleanest!.gco2eq_kwh} ${UNIT} (${cleanest!.age_human}) and ` +
              `${dirtiest!.zone}${dirtiest!.zone_name ? ` (${dirtiest!.zone_name})` : ""} ` +
              `is highest at ${dirtiest!.gco2eq_kwh} ${UNIT} (${dirtiest!.age_human}). ` +
              `Each figure is that zone's newest published interval, not a common moment.`;

        const output = {
          unit: UNIT,
          order,
          comparison_basis:
            gbRanked.length > 0
              ? "MIXED BASIS — IPCC AR5 lifecycle factors, except GB which is operational (combustion-only). Not like-for-like."
              : "IPCC AR5 lifecycle factors" +
                (excluded.some((e) => usesOperationalFactors(e.zone))
                  ? " (GB excluded: operational factors)"
                  : ""),
          ranked_count: ranked.length,
          omitted_by_limit,
          ranked,
          ...(cleanest ? { cleanest } : {}),
          ...(dirtiest ? { dirtiest } : {}),
          ...(cleanest && dirtiest
            ? {
                spread_gco2eq_kwh:
                  Math.round((dirtiest.gco2eq_kwh - cleanest.gco2eq_kwh) * 10) / 10,
              }
            : {}),
          excluded_from_ranking: excluded,
          observation_times,
          headline,
          warnings,
        };

        let text: string;
        if (response_format === "json") {
          text = JSON.stringify(output, null, 2);
        } else {
          const lines = [
            `# Carbon intensity ranking (${order.replace("_", " ")}, ${UNIT}, lower is cleaner)`,
            "",
            `Basis: ${output.comparison_basis}`,
            "",
            "| # | Zone | Name | Value | Band | Interval start (UTC) | Age |",
            "| -: | :--- | :--- | ----: | :--- | :------------------- | :-- |",
          ];
          for (const row of ranked) {
            lines.push(
              `| ${row.rank} | \`${row.zone}\` | ${row.zone_name ?? ""} | ` +
                `${row.gco2eq_kwh} | ${row.comparable ? (row.band ?? "") : "⚠️ NOT COMPARABLE (operational factors)"} | ` +
                `${row.ts} | ${row.age_human} |`,
            );
          }
          lines.push("", headline);
          if (excluded.length > 0) {
            lines.push("", "## Not ranked");
            for (const item of excluded) {
              const value =
                item.gco2eq_kwh !== undefined
                  ? ` — reported value **${item.gco2eq_kwh} ${UNIT}** at ${prettyTs(item.ts!)} (${item.age_human})`
                  : "";
              lines.push(
                `- **${item.zone}**${item.zone_name ? ` (${item.zone_name})` : ""}${value}`,
                `  - ${item.reason}`,
              );
            }
          }
          if (warnings.length > 0) {
            lines.push("");
            for (const warning of warnings) lines.push(`> ⚠️ ${warning}`);
          }
          text = lines.join("\n");
        }

        return ok(text, output);
      } catch (error) {
        return fail(error);
      }
    },
  );
}
