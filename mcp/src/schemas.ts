/** Zod input/output schemas shared by the tools. */

import { z } from "zod";

export const ResponseFormat = z
  .enum(["markdown", "json"])
  .default("markdown")
  .describe(
    "Output format for the text content. 'markdown' is compact and human-readable; " +
      "'json' returns the full structured payload as text. Structured data is always " +
      "returned alongside either way.",
  );

export const ZoneParam = z
  .string()
  .min(1)
  .max(32)
  .describe(
    "Zone code, e.g. 'DE' (Germany-Luxembourg), 'FR' (France), 'US-ERCOT' (Texas), " +
      "'IT-NORD', 'GB'. Case-insensitive and '_' is accepted for '-'. An unambiguous " +
      "country/region name such as 'Texas' or 'Portugal' also resolves. Call list_zones " +
      "if you are unsure — never substitute a neighbouring zone that is not covered.",
  );

/** Structured shape of one normalised reading. Kept permissive on purpose. */
export const ReadingShape = {
  zone: z.string(),
  zone_name: z.string().optional(),
  source: z.string().optional(),
  resolution_min: z.number().optional(),
  ts: z.string().describe("Interval START, ISO-8601 UTC."),
  gco2eq_kwh: z.number(),
  unit: z.string(),
  method: z.string(),
  age_minutes: z.number(),
  age_human: z.string(),
  freshness: z.enum(["fresh", "normal", "stale", "very_stale"]),
  operational_factors_only: z.boolean(),
  warning: z.string().optional(),
};

export const ReadingSchema = z.object(ReadingShape);
