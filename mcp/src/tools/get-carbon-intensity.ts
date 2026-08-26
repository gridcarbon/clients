/** Tool: get_carbon_intensity -- newest published intensity for a single zone. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { fetchLatest, fetchZones, GridCarbonError } from "../api.js";
import {
  DATA_CONTRACT_NOTE,
  GB_CAVEAT_SHORT,
  LATEST_CACHE_TTL_MINUTES,
  UNIT,
} from "../constants.js";
import {
  asOfStatement,
  fail,
  intensityBand,
  ok,
  readingToMarkdown,
  resolveZoneCode,
  toReading,
} from "../format.js";
import { ReadingShape, ResponseFormat, ZoneParam } from "../schemas.js";

const inputSchema = {
  zone: ZoneParam,
  response_format: ResponseFormat,
};

const outputSchema = {
  reading: z.object(ReadingShape),
  as_of_statement: z
    .string()
    .describe("A ready-to-quote sentence that states the value with its as-of time."),
  unit: z.string(),
  interpretation: z.string().optional(),
  warnings: z.array(z.string()),
};

export function registerGetCarbonIntensity(server: McpServer): void {
  server.registerTool(
    "get_carbon_intensity",
    {
      title: "Get latest grid carbon intensity for a zone",
      description: `Return the most recently published carbon intensity for ONE electricity zone.

Answers questions like "how clean is the German grid right now", "should I run this batch
job in Ireland or leave it", "what is the CO2 per kWh in Texas".

${DATA_CONTRACT_NOTE}

Args:
  - zone (string, required): Zone code such as "DE", "FR", "US-ERCOT", "IT-NORD", "GB".
    Case-insensitive; unambiguous names like "Texas" or "Portugal" also resolve.
    Unknown zones return an error listing near matches — do NOT fall back to a
    neighbouring country.
  - response_format ("markdown" | "json", default "markdown"): text rendering.

Returns (structured):
  {
    "reading": {
      "zone": "DE", "zone_name": "Germany-Luxembourg", "source": "entsoe",
      "resolution_min": 60,
      "ts": "2026-08-26T01:00:00Z",   // START of the interval, UTC
      "gco2eq_kwh": 371.4, "unit": "${UNIT}",
      "method": "computed:v1",
      "age_minutes": 107, "age_human": "1h 47m ago",
      "freshness": "normal",            // fresh | normal | stale | very_stale
      "operational_factors_only": false,
      "warning": "..."                  // present only when something could mislead
    },
    "as_of_statement": "As of 2026-08-26 01:00 UTC ... was 371.4 ${UNIT}.",
    "unit": "${UNIT}",
    "interpretation": "371.4 ${UNIT} is fossil-heavy.",
    "warnings": []
  }

How to report the answer:
  Quote or paraphrase "as_of_statement". Always include the timestamp or the age.
  Never say "currently" or "right now" about a reading whose freshness is "stale" or
  "very_stale", and never about any US zone without naming the time it refers to.

Examples:
  - "How clean is France's grid?" -> zone="FR"
  - "Carbon intensity in Texas" -> zone="US-ERCOT" (freshness will be ~1 day old; say so)
  - Don't use for: comparing several zones (use compare_zones), or for a time series
    (use get_intensity_history).

Errors:
  - Unknown zone -> "Unknown zone \\"XX\\". ... Call list_zones ..." with suggestions.
  - Network/timeout -> a message saying the API is unreachable. Do not invent a value.
  - A covered zone with no published data yet returns "No published data for <zone> yet."`,
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ zone, response_format }) => {
      try {
        const zones = await fetchZones();
        const code = resolveZoneCode(zone, zones);
        const meta = zones.find((z) => z.zone === code);

        const latest = await fetchLatest(code);
        const item = latest.data?.[0];
        if (!item) {
          throw new GridCarbonError(
            `No published data for ${code} yet. The zone is covered but the upstream ` +
              `source has not delivered any interval. Try again later, or call ` +
              `get_intensity_history to see whether older data exists.`,
          );
        }

        const reading = toReading(code, item, meta);
        const warnings: string[] = [];
        if (reading.warning) warnings.push(reading.warning);
        warnings.push(
          `"latest" means newest published, not "now". This value covers the interval ` +
            `starting ${reading.ts} (UTC) and is ${reading.age_human}.`,
        );

        const output = {
          reading,
          as_of_statement: asOfStatement(reading),
          unit: UNIT,
          ...(reading.operational_factors_only
            ? {}
            : {
                interpretation: `${reading.gco2eq_kwh} ${UNIT} is ${intensityBand(
                  reading.gco2eq_kwh,
                )} (lower is cleaner).`,
              }),
          warnings,
        };

        const text =
          response_format === "json"
            ? JSON.stringify(output, null, 2)
            : [
                readingToMarkdown(reading),
                "",
                output.as_of_statement,
                "",
                `_Newest published value; the API caches /latest for ${LATEST_CACHE_TTL_MINUTES} minutes. "Latest" means newest published, not "now"._`,
                ...(reading.operational_factors_only
                  ? ["", `> ⚠️ ${GB_CAVEAT_SHORT}`]
                  : []),
              ].join("\n");

        return ok(text, output);
      } catch (error) {
        return fail(error);
      }
    },
  );
}
