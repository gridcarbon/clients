/** Tool: list_zones -- the covered electricity zones, with source and resolution. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { fetchZones } from "../api.js";
import {
  EXPECTED_LAG_HOURS,
  GB_CAVEAT_SHORT,
  HISTORY_STARTS_AT,
} from "../constants.js";
import { fail, ok, usesOperationalFactors } from "../format.js";
import { ResponseFormat } from "../schemas.js";

const SOURCE_NOTES: Record<string, string> = {
  entsoe:
    "ENTSO-E Transparency Platform. Lifecycle (IPCC AR5) factors applied to the " +
    "published generation mix. Typically 2-4 hours behind real time.",
  eia:
    "U.S. Energy Information Administration (EIA-930). Lifecycle (IPCC AR5) factors " +
    "applied to the published generation mix. Typically 11-28 hours behind real time.",
  "uk-neso":
    "NESO Carbon Intensity API, passed through unchanged. OPERATIONAL " +
    "(combustion-only) factors — NOT comparable with the other 44 zones. " +
    "Typically 1-2 hours behind, and the newest interval may be a forecast.",
};

const inputSchema = {
  source: z
    .enum(["entsoe", "eia", "uk-neso"])
    .optional()
    .describe(
      "Only return zones from this upstream source. 'entsoe' = Europe, " +
        "'eia' = United States, 'uk-neso' = Great Britain.",
    ),
  search: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe(
      "Case-insensitive substring filter over the zone code and the zone name, " +
        "e.g. 'italy', 'NO-', 'iso'.",
    ),
  response_format: ResponseFormat,
};

const outputSchema = {
  count: z.number(),
  total_covered: z.number(),
  zones: z.array(
    z.object({
      zone: z.string(),
      name: z.string(),
      source: z.string(),
      resolution_min: z.number(),
      factor_basis: z.enum(["lifecycle", "operational"]),
      typical_lag_hours: z.number(),
      comparable_with_others: z.boolean(),
    }),
  ),
  history_starts_at: z.string(),
  notes: z.array(z.string()),
};

export function registerListZones(server: McpServer): void {
  server.registerTool(
    "list_zones",
    {
      title: "List covered electricity zones",
      description: `List every electricity zone gridcarbon covers, with its upstream data source, its
reporting resolution, and whether its numbers are comparable with the rest.

Call this whenever you are not certain a zone code exists. The data tools reject unknown
codes on purpose — there is no sensible fallback, and substituting a neighbouring
country's grid would be a fabrication.

Coverage is 45 zones: continental Europe + Nordics + Ireland (ENTSO-E), 10 US balancing
authorities plus a Lower-48 aggregate (EIA), and Great Britain (NESO). There is NO
coverage of Canada, Australia, Japan, China, India, Latin America or Africa.

This tool returns no measurements itself, but the values the other tools return follow
one contract: the unit is gCO2eq/kWh and LOWER IS CLEANER; each value's "ts" is the
START of its reporting interval in UTC; and "latest" means NEWEST PUBLISHED, NOT "now"
— see typical_lag_hours below and always quote the timestamp with the number.

Two things this list tells you that matter for correctness:
  - factor_basis: "lifecycle" for 44 zones (IPCC AR5, includes construction and fuel
    supply chain) versus "operational" for GB (combustion only). ${GB_CAVEAT_SHORT}
  - typical_lag_hours: how far behind real time that source normally publishes.
    US zones are routinely ~1 day behind. This is normal, not an outage — but it means
    a US value must never be described as "right now".

Args:
  - source ("entsoe" | "eia" | "uk-neso", optional): filter by upstream provider.
  - search (string, optional): case-insensitive substring over zone code and name.
  - response_format ("markdown" | "json", default "markdown").

Returns (structured):
  {
    "count": 45, "total_covered": 45,
    "zones": [
      { "zone": "DE", "name": "Germany-Luxembourg", "source": "entsoe",
        "resolution_min": 60, "factor_basis": "lifecycle",
        "typical_lag_hours": 4, "comparable_with_others": true },
      { "zone": "GB", "name": "Great Britain", "source": "uk-neso",
        "resolution_min": 30, "factor_basis": "operational",
        "typical_lag_hours": 2, "comparable_with_others": false }
    ],
    "history_starts_at": "${HISTORY_STARTS_AT}",
    "notes": [...]
  }

Examples:
  - "Which US grids do you cover?" -> source="eia"
  - "Do you have Italy?" -> search="italy" (returns the 7 Italian bidding zones)
  - "Is Japan supported?" -> search="japan" returns zero rows; say it is not covered.`,
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ source, search, response_format }) => {
      try {
        const all = await fetchZones();
        const needle = search?.trim().toLowerCase();
        const filtered = all.filter((zone) => {
          if (source && zone.source !== source) return false;
          if (!needle) return true;
          return (
            zone.zone.toLowerCase().includes(needle) ||
            zone.name.toLowerCase().includes(needle)
          );
        });

        const zones = filtered.map((zone) => {
          const operational = usesOperationalFactors(zone.zone);
          return {
            zone: zone.zone,
            name: zone.name,
            source: zone.source,
            resolution_min: zone.resolution_min,
            factor_basis: operational
              ? ("operational" as const)
              : ("lifecycle" as const),
            typical_lag_hours: EXPECTED_LAG_HOURS[zone.source] ?? 4,
            comparable_with_others: !operational,
          };
        });

        const notes = [
          `44 of 45 zones use IPCC AR5 lifecycle emission factors. ${GB_CAVEAT_SHORT}`,
          "typical_lag_hours is the usual publication delay, not a guarantee. Always " +
            "read the ts and age returned by get_carbon_intensity before calling a value current.",
          `History starts ${HISTORY_STARTS_AT}; nothing earlier exists.`,
          "Attribution required: ENTSO-E Transparency Platform / U.S. Energy Information " +
            "Administration (EIA) / NESO Carbon Intensity API. EIA does not endorse this service.",
        ];

        const output = {
          count: zones.length,
          total_covered: all.length,
          zones,
          history_starts_at: HISTORY_STARTS_AT,
          notes,
        };

        let text: string;
        if (response_format === "json") {
          text = JSON.stringify(output, null, 2);
        } else if (zones.length === 0) {
          text =
            `No covered zone matches that filter (${all.length} zones are covered in ` +
            `total: ENTSO-E Europe, EIA United States, NESO Great Britain). ` +
            `That region is not supported — say so rather than offering a nearby zone.`;
        } else {
          const lines = [
            `# Covered zones (${zones.length}${
              zones.length === all.length ? "" : ` of ${all.length}`
            })`,
            "",
            "| Zone | Name | Source | Res (min) | Factors | Typical lag |",
            "| :--- | :--- | :----- | --------: | :------ | :---------- |",
          ];
          for (const zone of zones) {
            lines.push(
              `| \`${zone.zone}\` | ${zone.name} | ${zone.source} | ${zone.resolution_min} | ` +
                `${zone.factor_basis}${zone.comparable_with_others ? "" : " ⚠️"} | ~${zone.typical_lag_hours}h |`,
            );
          }
          lines.push("");
          const usedSources = [...new Set(zones.map((z) => z.source))];
          for (const src of usedSources) {
            lines.push(`- **${src}** — ${SOURCE_NOTES[src] ?? ""}`);
          }
          lines.push("", ...notes.map((note) => `> ${note}`));
          text = lines.join("\n");
        }

        return ok(text, output);
      } catch (error) {
        return fail(error);
      }
    },
  );
}
