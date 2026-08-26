#!/usr/bin/env node
/**
 * End-to-end smoke test for gridcarbon-mcp.
 *
 * Spawns `node dist/index.js` and speaks raw newline-delimited JSON-RPC over its
 * stdio, exactly as an MCP client would: initialize -> notifications/initialized
 * -> tools/list -> tools/call for each tool. Hits the live API.
 *
 *   node scripts/smoke-test.mjs            # summary
 *   node scripts/smoke-test.mjs --raw      # also dump the literal tools/list result
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, "..", "dist", "index.js");
const RAW = process.argv.includes("--raw");

const child = spawn(process.execPath, [entry], {
  stdio: ["pipe", "pipe", "pipe"],
});

let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

const pending = new Map();
let buffer = "";
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      throw new Error(`Non-JSON line on stdout (would break the transport): ${line}`);
    }
    const resolve = pending.get(message.id);
    if (resolve) {
      pending.delete(message.id);
      resolve(message);
    }
  }
});

let nextId = 1;
function send(method, params) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for a response to ${method}`)),
      30_000,
    );
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
  });
}

function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

const failures = [];
function check(label, condition, detail) {
  const mark = condition ? "PASS" : "FAIL";
  console.log(`  [${mark}] ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures.push(label);
}

function textOf(result) {
  return (result?.content ?? []).map((part) => part.text ?? "").join("\n");
}

/** Spawn a second server against a throwaway HTTP stub and run one tool call. */
async function withStubApi(fn) {
  const stub = createServer((req, res) => {
    const url = new URL(req.url, "http://stub");
    const json = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/v1/zones") {
      return json(200, {
        data: [
          { zone: "DE", name: "Germany-Luxembourg", source: "entsoe", resolution_min: 60 },
        ],
      });
    }
    if (url.pathname === "/v1/intensity") {
      const data = [];
      for (let i = 0; i < 5000; i += 1) {
        data.push({
          ts: `${new Date(Date.UTC(2026, 7, 21) + i * 60_000).toISOString().slice(0, 19)}Z`,
          gco2eq_kwh: 300 + (i % 7),
          method: "computed:v1",
        });
      }
      return json(200, {
        zone: "DE",
        from: "2026-08-21T00:00:00Z",
        to: "2026-08-26T00:00:00Z",
        unit: "gCO2eq/kWh",
        count: 5000,
        truncated: true,
        note: "response capped at 5000 points; narrow the window",
        data,
      });
    }
    return json(404, { error: `no such path ${url.pathname}` });
  });
  await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const { port } = stub.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => stub.close(resolve));
  }
}

/** initialize -> one tools/call -> exit, against a server pointed at baseUrl. */
function callOnce(baseUrl, name, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [entry], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, GRIDCARBON_API_URL: baseUrl },
    });
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`Timed out calling ${name} against the stub API`));
    }, 30_000);
    let buf = "";
    proc.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      let index;
      while ((index = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, index).trim();
        buf = buf.slice(index + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        if (message.id === 2) {
          clearTimeout(timer);
          proc.stdin.end();
          proc.kill();
          resolve(message);
        }
      }
    });
    proc.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "gridcarbon-smoke-test", version: "0.1.0" },
        },
      })}\n`,
    );
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    proc.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } })}\n`,
    );
  });
}

try {
  console.log("== initialize ==");
  const init = await send("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "gridcarbon-smoke-test", version: "0.1.0" },
  });
  check("server responded to initialize", Boolean(init.result));
  check(
    "serverInfo",
    init.result?.serverInfo?.name === "gridcarbon",
    JSON.stringify(init.result?.serverInfo),
  );
  check(
    "instructions mention the GB caveat",
    (init.result?.instructions ?? "").includes("Great Britain is not comparable"),
  );
  notify("notifications/initialized", {});

  console.log("\n== tools/list ==");
  const list = await send("tools/list", {});
  const tools = list.result?.tools ?? [];
  const names = tools.map((tool) => tool.name).sort();
  check(
    "four tools registered",
    names.join(",") ===
      "compare_zones,get_carbon_intensity,get_intensity_history,list_zones",
    names.join(", "),
  );
  for (const tool of tools) {
    check(
      `${tool.name}: description covers unit, ts-is-UTC-interval-start, latest!=now, GB`,
      /gCO2eq\/kWh/.test(tool.description) &&
        /START of (the|its)/i.test(tool.description) &&
        /(newest published|not "now"|NOT "now")/i.test(tool.description) &&
        /(GB|Great Britain)/.test(tool.description),
    );
    check(
      `${tool.name}: readOnly + inputSchema + outputSchema`,
      tool.annotations?.readOnlyHint === true &&
        tool.inputSchema?.type === "object" &&
        tool.outputSchema?.type === "object",
    );
  }
  if (RAW) {
    console.log("\n--- literal tools/list result ---");
    console.log(JSON.stringify(list, null, 2));
    console.log("--- end tools/list result ---\n");
  }

  console.log("\n== tools/call: list_zones ==");
  const zones = await send("tools/call", {
    name: "list_zones",
    arguments: { source: "eia", response_format: "json" },
  });
  const zonesOut = zones.result?.structuredContent;
  check("45 zones covered", zonesOut?.total_covered === 45, `total_covered=${zonesOut?.total_covered}`);
  check("11 EIA zones returned", zonesOut?.count === 11, `count=${zonesOut?.count}`);

  const gbList = await send("tools/call", {
    name: "list_zones",
    arguments: { search: "britain", response_format: "json" },
  });
  check(
    "GB flagged operational / not comparable",
    gbList.result?.structuredContent?.zones?.[0]?.factor_basis === "operational" &&
      gbList.result?.structuredContent?.zones?.[0]?.comparable_with_others === false,
  );

  console.log("\n== tools/call: get_carbon_intensity ==");
  const de = await send("tools/call", {
    name: "get_carbon_intensity",
    arguments: { zone: "DE", response_format: "json" },
  });
  const deReading = de.result?.structuredContent?.reading;
  check("DE reading has a numeric value", typeof deReading?.gco2eq_kwh === "number", `${deReading?.gco2eq_kwh} gCO2eq/kWh`);
  check("DE reading carries zone, ts, age", Boolean(deReading?.zone && deReading?.ts && typeof deReading?.age_minutes === "number"), `ts=${deReading?.ts} age=${deReading?.age_human}`);
  check("as_of_statement present", typeof de.result?.structuredContent?.as_of_statement === "string");

  const texas = await send("tools/call", {
    name: "get_carbon_intensity",
    arguments: { zone: "Texas", response_format: "json" },
  });
  check(
    "name resolution: 'Texas' -> US-ERCOT",
    texas.result?.structuredContent?.reading?.zone === "US-ERCOT",
    `age=${texas.result?.structuredContent?.reading?.age_human}, freshness=${texas.result?.structuredContent?.reading?.freshness}`,
  );

  const gb = await send("tools/call", {
    name: "get_carbon_intensity",
    arguments: { zone: "GB", response_format: "json" },
  });
  check(
    "GB reading flagged operational_factors_only with a warning",
    gb.result?.structuredContent?.reading?.operational_factors_only === true &&
      /operational/i.test(gb.result?.structuredContent?.reading?.warning ?? ""),
  );

  const bad = await send("tools/call", {
    name: "get_carbon_intensity",
    arguments: { zone: "ZZ" },
  });
  check(
    "unknown zone -> isError with guidance",
    bad.result?.isError === true && /list_zones/.test(textOf(bad.result)),
    textOf(bad.result).slice(0, 90),
  );

  console.log("\n== tools/call: get_intensity_history ==");
  const hist = await send("tools/call", {
    name: "get_intensity_history",
    arguments: {
      zone: "DE",
      from: "2026-08-25T18:00:00Z",
      to: "2026-08-26T00:00:00Z",
      response_format: "json",
    },
  });
  const histOut = hist.result?.structuredContent;
  check("6 points for the 6-hour window", histOut?.count === 6, `count=${histOut?.count}`);
  check("summary computed", typeof histOut?.summary?.mean === "number", `mean=${histOut?.summary?.mean}`);
  check(
    "server_truncated present and false for a small live window",
    histOut?.server_truncated === false,
  );

  const empty = await send("tools/call", {
    name: "get_intensity_history",
    arguments: {
      zone: "DE",
      from: "2020-01-01T00:00:00Z",
      to: "2020-01-02T00:00:00Z",
      response_format: "json",
    },
  });
  check(
    "pre-coverage window -> zero points, explained",
    empty.result?.structuredContent?.count === 0 &&
      /No intervals published/.test(textOf(empty.result)),
  );

  const badWindow = await send("tools/call", {
    name: "get_intensity_history",
    arguments: { zone: "DE", from: "2026-08-26T00:00:00Z", to: "2026-08-25T00:00:00Z" },
  });
  check("inverted window -> isError", badWindow.result?.isError === true, textOf(badWindow.result).slice(0, 80));

  console.log("\n== tools/call: compare_zones ==");
  const cmp = await send("tools/call", {
    name: "compare_zones",
    arguments: { zones: ["FR", "PL", "GB", "SE-3"], response_format: "json" },
  });
  const cmpOut = cmp.result?.structuredContent;
  check(
    "GB excluded from the ranking by default",
    cmpOut?.ranked?.every((row) => row.zone !== "GB") === true &&
      cmpOut?.excluded_from_ranking?.some((row) => row.zone === "GB") === true,
  );
  check(
    "excluded GB still reports its value",
    typeof cmpOut?.excluded_from_ranking?.find((row) => row.zone === "GB")?.gco2eq_kwh ===
      "number",
    `GB=${cmpOut?.excluded_from_ranking?.find((row) => row.zone === "GB")?.gco2eq_kwh}`,
  );
  check(
    "ranked ascending, every row timestamped",
    cmpOut?.ranked?.every((row, i, arr) => i === 0 || arr[i - 1].gco2eq_kwh <= row.gco2eq_kwh) &&
      cmpOut?.ranked?.every((row) => Boolean(row.ts) && typeof row.age_minutes === "number"),
    cmpOut?.ranked?.map((r) => `${r.zone}=${r.gco2eq_kwh}`).join(" < "),
  );

  const cmpGb = await send("tools/call", {
    name: "compare_zones",
    arguments: { zones: ["FR", "GB"], include_gb_in_ranking: true, response_format: "json" },
  });
  check(
    "opt-in GB ranking is flagged NOT COMPARABLE in row + warning + basis",
    cmpGb.result?.structuredContent?.ranked?.find((r) => r.zone === "GB")?.comparable === false &&
      /MIXED BASIS/.test(cmpGb.result?.structuredContent?.comparison_basis ?? "") &&
      cmpGb.result?.structuredContent?.warnings?.some((w) => /NOT A LIKE-FOR-LIKE/.test(w)),
  );

  const cmpMixed = await send("tools/call", {
    name: "compare_zones",
    arguments: { zones: ["DE", "US-ERCOT", "XX"], response_format: "json" },
  });
  check(
    "unknown code reported, not silently dropped",
    cmpMixed.result?.structuredContent?.excluded_from_ranking?.some(
      (row) => row.zone === "XX" && /Unknown zone code/.test(row.reason),
    ),
  );
  check(
    "EU-vs-US age gap warning fires",
    cmpMixed.result?.structuredContent?.warnings?.some((w) =>
      /not observed at the same time/.test(w),
    ),
    `gap=${cmpMixed.result?.structuredContent?.observation_times?.age_gap_minutes} min`,
  );

  const cleanest = await send("tools/call", {
    name: "compare_zones",
    arguments: { limit: 5, response_format: "json" },
  });
  check(
    "rank-all defaults to 44 comparable zones + GB excluded",
    cleanest.result?.structuredContent?.ranked?.length === 5 &&
      cleanest.result?.structuredContent?.excluded_from_ranking?.some((r) => r.zone === "GB"),
    cleanest.result?.structuredContent?.ranked?.map((r) => `${r.zone}=${r.gco2eq_kwh}`).join(", "),
  );

  const capped = cleanest.result?.structuredContent;
  const cappedZones = new Set((capped?.ranked ?? []).map((r) => r.zone));
  check(
    "limit=5: headline and extremes describe only the 5 returned rows",
    capped?.ranked_count === 5 &&
      capped?.omitted_by_limit === 39 &&
      cappedZones.has(capped?.cleanest?.zone) &&
      cappedZones.has(capped?.dirtiest?.zone) &&
      /Of 5 zone\(s\) ranked/.test(capped?.headline ?? ""),
    `omitted_by_limit=${capped?.omitted_by_limit}, dirtiest=${capped?.dirtiest?.zone}`,
  );
  check(
    "limit=5: the trimmed rows are declared, not hidden",
    (capped?.warnings ?? []).some((w) => /limit=5 kept only/.test(w)),
  );

  console.log("\n== truncation (stub API) ==");
  const truncated = await withStubApi(async (baseUrl) => {
    const res = await callOnce(baseUrl, "get_intensity_history", {
      zone: "DE",
      from: "2026-08-21T00:00:00Z",
      to: "2026-08-26T00:00:00Z",
      response_format: "json",
    });
    return res;
  });
  const tOut = truncated.result?.structuredContent;
  check(
    "server truncated=true is surfaced as server_truncated",
    tOut?.server_truncated === true,
    `count=${tOut?.count}`,
  );
  check(
    "truncation is stated loudly in the warnings and the API note is kept",
    (tOut?.warnings ?? []).some(
      (w) =>
        /INCOMPLETE SERIES/.test(w) &&
        /API note: response capped at 5000 points; narrow the window\. Do not average/.test(w),
    ),
    (tOut?.warnings ?? [])[0]?.slice(0, 80),
  );

  console.log("\n== stdio hygiene ==");
  check("nothing but JSON-RPC on stdout", true, "every stdout line parsed as JSON");
  check(
    "startup banner went to stderr",
    /ready on stdio/.test(stderr),
    stderr.trim().split("\n")[0],
  );
} finally {
  child.stdin.end();
  child.kill();
}

console.log(
  failures.length === 0
    ? "\nAll checks passed."
    : `\n${failures.length} check(s) FAILED:\n - ${failures.join("\n - ")}`,
);
process.exit(failures.length === 0 ? 0 : 1);
