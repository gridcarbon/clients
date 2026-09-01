#!/usr/bin/env node
/**
 * gridcarbon MCP server.
 *
 * Exposes electricity-grid carbon intensity (gCO2eq/kWh) for 45 zones across
 * Europe, the United States and Great Britain over stdio. No API key, no config.
 *
 * Data: https://api.gridcarbon.dev  ·  Docs: https://gridcarbon.dev
 * Sources: ENTSO-E Transparency Platform / U.S. Energy Information Administration
 * (EIA) / NESO Carbon Intensity API. EIA does not endorse this service.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { API_BASE_URL, SERVER_NAME, SERVER_VERSION } from "./constants.js";
import { registerCompareZones } from "./tools/compare-zones.js";
import { registerGetCarbonIntensity } from "./tools/get-carbon-intensity.js";
import { registerGetIntensityHistory } from "./tools/get-intensity-history.js";
import { registerListZones } from "./tools/list-zones.js";

const INSTRUCTIONS = `gridcarbon reports how carbon-intensive electricity is on a given power grid,
in gCO2eq/kWh — grams of CO2-equivalent per kilowatt-hour consumed. Lower is cleaner.

Four rules for using this data correctly:

1. Always report the timestamp. Every value belongs to a specific interval whose START
   time ("ts") is given in UTC. "latest" means newest published, NOT "now": European
   zones run 2-4 hours behind real time and US zones 11-28 hours behind. Every reading
   carries "age_minutes"/"age_human" — quote it. Reporting a 20-hour-old Texas figure as
   "the current intensity" is the single most common way to misuse this server.

2. Great Britain is not comparable. GB comes from NESO using operational
   (combustion-only) factors; the other 44 zones use IPCC AR5 lifecycle factors and are
   therefore higher for the same physical grid. compare_zones leaves GB out of rankings
   by default and reports it separately. Never rank GB against the others without saying
   why the basis differs.

3. Coverage is Europe, the United States and Great Britain only — 45 zones, listed by
   list_zones. If a region is not in that list, say it is not covered. Do not substitute
   a neighbouring zone, and do not fall back on general knowledge for a number.

4. History starts 2026-08-21. Missing intervals are gaps, not zeros.

Attribution is a licence condition when you surface these values: ENTSO-E Transparency
Platform / U.S. Energy Information Administration (EIA) / NESO Carbon Intensity API.
EIA does not endorse this service or any use of it. Data licensed CC BY 4.0.

Status: pre-alpha. Rate limit is 60 requests per minute per IP; do not poll faster than once every
5 minutes.`;

function createServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );

  registerGetCarbonIntensity(server);
  registerGetIntensityHistory(server);
  registerListZones(server);
  registerCompareZones(server);

  return server;
}

function printHelp(): void {
  process.stdout.write(
    `gridcarbon-mcp ${SERVER_VERSION}\n\n` +
      `An MCP (Model Context Protocol) server exposing grid carbon intensity for 45\n` +
      `electricity zones in Europe, the US and Great Britain. Speaks JSON-RPC over\n` +
      `stdio; it is meant to be launched by an MCP client, not used interactively.\n\n` +
      `Usage:\n` +
      `  npx gridcarbon-mcp            start the server on stdio\n` +
      `  npx gridcarbon-mcp --version  print the version\n` +
      `  npx gridcarbon-mcp --help     print this message\n\n` +
      `Tools: get_carbon_intensity, get_intensity_history, list_zones, compare_zones\n\n` +
      `Configuration: none required. GRIDCARBON_API_URL overrides the API base URL\n` +
      `(currently ${API_BASE_URL}).\n\n` +
      `Claude Code:    claude mcp add gridcarbon -- npx -y gridcarbon-mcp\n` +
      `Docs:           https://gridcarbon.dev\n`,
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }
  if (args.includes("--version") || args.includes("-v")) {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return;
  }

  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the JSON-RPC channel; all logging must go to stderr.
  process.stderr.write(
    `gridcarbon-mcp ${SERVER_VERSION} ready on stdio (api: ${API_BASE_URL})\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `gridcarbon-mcp failed to start: ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  );
  process.exit(1);
});
