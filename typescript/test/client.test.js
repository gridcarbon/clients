import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  AbortError,
  ApiError,
  GridCarbon,
  GridCarbonError,
  MalformedResponseError,
  NetworkError,
  SERIES_POINT_LIMIT,
  TruncatedSeriesError,
  UnknownZoneError,
  VERSION,
} from "../dist/index.js";

import {
  captureWarnings,
  hangingFetch,
  jsonResponse,
  LATEST_ALL_BODY,
  LATEST_DE_BODY,
  SERIES_DE_BODY,
  SERIES_EMPTY_BODY,
  SERIES_TRUNCATED_BODY,
  stubFetch,
  stubSequence,
  ZONES_BODY,
} from "./helpers.js";

// Nothing in this file is allowed to touch the network. Trip the wire if it does.
const realFetch = globalThis.fetch;
globalThis.fetch = () => {
  throw new Error("a test reached for the real global fetch - stub it instead");
};
after(() => {
  globalThis.fetch = realFetch;
});

const client = (fetchImpl, options = {}) => new GridCarbon({ fetch: fetchImpl, ...options });

describe("packaging", () => {
  it("exports a version that matches package.json", () => {
    // Read rather than `import ... with { type: "json" }`: the import-attribute
    // syntax is a SyntaxError on Node 18/20, which `engines` still supports.
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    );
    assert.equal(VERSION, pkg.version);
  });

  it("documents the server-side point cap", () => {
    assert.equal(SERIES_POINT_LIMIT, 5000);
  });

  it("defaults to the public API root", () => {
    assert.equal(new GridCarbon().baseUrl, "https://api.gridcarbon.dev");
  });

  it("strips trailing slashes from a custom baseUrl", () => {
    assert.equal(new GridCarbon({ baseUrl: "http://localhost:8787//" }).baseUrl, "http://localhost:8787");
  });
});

describe("request shaping", () => {
  it("sends a descriptive User-Agent and an Accept header", async () => {
    const f = stubSequence(jsonResponse(ZONES_BODY));
    await client(f).zones();
    const { init } = f.calls[0];
    assert.match(init.headers["user-agent"], /^gridcarbon-js\/\d+\.\d+\.\d+/);
    assert.equal(init.headers["accept"], "application/json");
    assert.equal(init.method, "GET");
  });

  it("honours a custom userAgent and baseUrl", async () => {
    const f = stubSequence(jsonResponse(ZONES_BODY));
    await client(f, { baseUrl: "https://example.test/api", userAgent: "my-app/2.0" }).zones();
    assert.equal(f.calls[0].url, "https://example.test/api/v1/zones");
    assert.equal(f.calls[0].init.headers["user-agent"], "my-app/2.0");
  });

  it("uppercases and trims the zone before sending it", async () => {
    const f = stubSequence(jsonResponse(LATEST_DE_BODY));
    await client(f).latest("  de  ");
    assert.equal(f.calls[0].url, "https://api.gridcarbon.dev/v1/intensity/latest?zone=DE");
  });

  it("omits from/to when no window is given", async () => {
    const f = stubSequence(jsonResponse(SERIES_DE_BODY));
    await client(f).series("DE");
    assert.equal(f.calls[0].url, "https://api.gridcarbon.dev/v1/intensity?zone=DE");
  });

  it("accepts Date, ISO string and epoch millis for the window", async () => {
    const f = stubSequence(
      jsonResponse(SERIES_DE_BODY),
      jsonResponse(SERIES_DE_BODY),
      jsonResponse(SERIES_DE_BODY),
    );
    const gc = client(f);
    await gc.series("DE", { start: new Date("2026-08-25T18:00:00Z"), end: new Date("2026-08-26T00:00:00Z") });
    await gc.series("DE", { start: "2026-08-25T18:00:00Z" });
    await gc.series("DE", { start: Date.UTC(2026, 7, 25, 18) });
    for (const call of f.calls) {
      assert.ok(call.url.includes("from=2026-08-25T18%3A00%3A00.000Z"), call.url);
    }
    assert.ok(f.calls[0].url.includes("to=2026-08-26T00%3A00%3A00.000Z"));
  });

  it("rejects an unparseable window bound before making a request", async () => {
    const f = stubSequence();
    await assert.rejects(() => client(f).series("DE", { start: "yesterday-ish" }), (err) => {
      assert.ok(err instanceof GridCarbonError);
      assert.match(err.message, /Invalid start/);
      return true;
    });
    assert.equal(f.calls.length, 0, "must not hit the network with a bad bound");
  });

  it("rejects an empty zone before making a request", async () => {
    const f = stubSequence();
    await assert.rejects(() => client(f).series("   "), GridCarbonError);
    await assert.rejects(() => client(f).latest(""), GridCarbonError);
    assert.equal(f.calls.length, 0);
  });
});

describe("zones()", () => {
  it("camel-cases the payload and flags GB as non-lifecycle", async () => {
    const zones = await client(stubSequence(jsonResponse(ZONES_BODY))).zones();
    assert.equal(zones.length, 4);
    assert.deepEqual(zones[1], {
      zone: "DE",
      name: "Germany-Luxembourg",
      source: "entsoe",
      resolutionMinutes: 60,
      isLifecycle: true,
    });
    const gb = zones.find((z) => z.zone === "GB");
    assert.equal(gb.isLifecycle, false, "GB uses operational factors, not lifecycle");
    assert.equal(gb.resolutionMinutes, 30);
    assert.deepEqual(
      zones.filter((z) => !z.isLifecycle).map((z) => z.zone),
      ["GB"],
    );
  });
});

describe("latest()", () => {
  it("returns an array for every zone, with ts as a Date", async () => {
    const readings = await client(stubSequence(jsonResponse(LATEST_ALL_BODY))).latest();
    assert.ok(Array.isArray(readings));
    assert.equal(readings.length, 3);
    assert.ok(readings[0].ts instanceof Date);
    assert.equal(readings[0].ts.toISOString(), "2026-08-26T01:00:00.000Z");
    assert.equal(readings[1].gco2eqPerKwh, 371.4);
    assert.equal(readings[1].isLifecycle, true);
  });

  it("marks GB readings as non-lifecycle", async () => {
    const readings = await client(stubSequence(jsonResponse(LATEST_ALL_BODY))).latest();
    const gb = readings.find((r) => r.zone === "GB");
    assert.equal(gb.method, "upstream:uk-neso:forecast");
    assert.equal(gb.isLifecycle, false);
  });

  it("returns a single Reading when a zone is given", async () => {
    const de = await client(stubSequence(jsonResponse(LATEST_DE_BODY))).latest("DE");
    assert.ok(!Array.isArray(de));
    assert.equal(de.zone, "DE");
    assert.equal(de.gco2eqPerKwh, 371.4);
    assert.equal(de.method, "computed:v1");
  });

  it("throws UnknownZoneError on the API's 404", async () => {
    const f = stubSequence(jsonResponse({ error: "unknown or empty zone: ZZ" }, 404));
    await assert.rejects(() => client(f).latest("ZZ"), (err) => {
      assert.ok(err instanceof UnknownZoneError);
      assert.ok(err instanceof ApiError, "UnknownZoneError must be catchable as ApiError");
      assert.ok(err instanceof GridCarbonError);
      assert.equal(err.name, "UnknownZoneError");
      assert.equal(err.zone, "ZZ");
      assert.equal(err.status, 404);
      assert.equal(err.serverMessage, "unknown or empty zone: ZZ");
      return true;
    });
  });

  it("throws UnknownZoneError if a 200 comes back with an empty data array", async () => {
    const f = stubSequence(jsonResponse({ unit: "gCO2eq/kWh", data: [] }));
    await assert.rejects(() => client(f).latest("ZZ"), UnknownZoneError);
  });

  it("returns an empty array when no zone has data at all", async () => {
    const f = stubSequence(jsonResponse({ unit: "gCO2eq/kWh", data: [] }));
    assert.deepEqual(await client(f).latest(), []);
  });
});

describe("series()", () => {
  it("copies the envelope zone onto every reading", async () => {
    const series = await client(stubSequence(jsonResponse(SERIES_DE_BODY))).series("DE");
    assert.equal(series.readings.length, 3);
    for (const r of series.readings) {
      assert.equal(r.zone, "DE", "items have no zone field - the SDK must fill it in");
      assert.ok(r.ts instanceof Date);
    }
    assert.equal(series.count, 3);
    assert.equal(series.truncated, false);
    assert.equal(series.note, undefined);
    assert.equal(series.start.toISOString(), "2026-08-25T18:00:00.000Z");
    assert.equal(series.end.toISOString(), "2026-08-26T00:00:00.000Z");
  });

  it("gives a consistent Reading shape across latest() and series()", async () => {
    const gc = client(stubSequence(jsonResponse(LATEST_DE_BODY), jsonResponse(SERIES_DE_BODY)));
    const a = await gc.latest("DE");
    const b = (await gc.series("DE")).readings[0];
    assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort());
  });

  it("returns an empty readings array for a window with no data", async () => {
    const series = await client(stubSequence(jsonResponse(SERIES_EMPTY_BODY))).series("DE", {
      start: "2026-01-01T00:00:00Z",
      end: "2026-01-02T00:00:00Z",
    });
    assert.deepEqual(series.readings, []);
    assert.equal(series.count, 0);
    assert.equal(series.truncated, false);
  });

  it("warns loudly by default when the server truncates", async () => {
    const { result, warnings } = await captureWarnings(() =>
      client(stubSequence(jsonResponse(SERIES_TRUNCATED_BODY))).series("DE"),
    );
    assert.equal(result.truncated, true);
    assert.match(result.note, /capped at 5000 points/);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /TRUNCATED/);
    assert.match(warnings[0], /capped at 5000 points/);
  });

  it("throws TruncatedSeriesError when configured to, keeping the partial data", async () => {
    const f = stubSequence(jsonResponse(SERIES_TRUNCATED_BODY));
    await assert.rejects(() => client(f, { onTruncated: "throw" }).series("DE"), (err) => {
      assert.ok(err instanceof TruncatedSeriesError);
      assert.ok(err instanceof GridCarbonError);
      assert.equal(err.series.truncated, true);
      assert.equal(err.series.readings.length, 2);
      return true;
    });
  });

  it("can be silenced per call", async () => {
    const { result, warnings } = await captureWarnings(() =>
      client(stubSequence(jsonResponse(SERIES_TRUNCATED_BODY))).series("DE", { onTruncated: "ignore" }),
    );
    assert.equal(warnings.length, 0);
    assert.equal(result.truncated, true, "the flag is still there even when silenced");
  });
});

describe("errors", () => {
  it("wraps a non-2xx with the server's message", async () => {
    const f = stubSequence(jsonResponse({ error: "missing required param: zone" }, 400));
    await assert.rejects(() => client(f).latest("DE"), (err) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 400);
      assert.equal(err.serverMessage, "missing required param: zone");
      assert.match(err.message, /missing required param: zone/);
      assert.match(err.url, /^https:\/\/api\.gridcarbon\.dev\//);
      return true;
    });
  });

  it("survives a non-JSON error body", async () => {
    const f = stubSequence(new Response("<html>502 Bad Gateway</html>", { status: 502 }));
    await assert.rejects(() => client(f).zones(), (err) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 502);
      assert.match(err.serverMessage, /Bad Gateway/);
      return true;
    });
  });

  it("wraps transport failures in NetworkError", async () => {
    const boom = new TypeError("fetch failed");
    const f = stubFetch(() => {
      throw boom;
    });
    await assert.rejects(() => client(f).zones(), (err) => {
      assert.ok(err instanceof NetworkError);
      assert.ok(err instanceof GridCarbonError);
      assert.equal(err.cause, boom);
      return true;
    });
  });

  it("throws AbortError when the timeout fires", async () => {
    const f = hangingFetch();
    await assert.rejects(() => client(f, { timeoutMs: 25 }).zones(), (err) => {
      assert.ok(err instanceof AbortError);
      assert.equal(err.name, "AbortError", "name must match the platform convention");
      assert.equal(err.timeoutMs, 25);
      assert.match(err.message, /timed out after 25 ms/);
      return true;
    });
  });

  it("throws AbortError when the caller's signal fires", async () => {
    const controller = new AbortController();
    const f = hangingFetch();
    const promise = client(f, { timeoutMs: 0 }).zones({ signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(() => promise, (err) => {
      assert.ok(err instanceof AbortError);
      assert.equal(err.timeoutMs, undefined, "not a timeout - the caller aborted");
      assert.match(err.message, /was aborted/);
      return true;
    });
  });

  it("throws immediately on an already-aborted signal", async () => {
    const f = hangingFetch();
    await assert.rejects(
      () => client(f).zones({ signal: AbortSignal.abort() }),
      AbortError,
    );
  });

  it("rejects a malformed 200 body", async () => {
    await assert.rejects(
      () => client(stubSequence(jsonResponse({ nope: true }))).zones(),
      MalformedResponseError,
    );
    await assert.rejects(
      () => client(stubSequence(new Response("not json", { status: 200 }))).zones(),
      MalformedResponseError,
    );
    await assert.rejects(
      () =>
        client(
          stubSequence(jsonResponse({ unit: "x", data: [{ zone: "DE", ts: "nope", gco2eq_kwh: 1, method: "computed:v1" }] })),
        ).latest("DE"),
      MalformedResponseError,
    );
  });

  it("explains itself when no fetch is available", async () => {
    const saved = globalThis.fetch;
    delete globalThis.fetch;
    try {
      await assert.rejects(() => new GridCarbon().zones(), (err) => {
        assert.ok(err instanceof GridCarbonError);
        assert.match(err.message, /No global fetch/);
        return true;
      });
    } finally {
      globalThis.fetch = saved;
    }
  });

  it("keeps every error under the GridCarbonError umbrella", () => {
    for (const Cls of [ApiError, UnknownZoneError, AbortError, NetworkError, MalformedResponseError, TruncatedSeriesError]) {
      assert.ok(Cls.prototype instanceof GridCarbonError || Cls === GridCarbonError, Cls.name);
    }
  });
});

describe("status() during an upstream outage", () => {
  // /v1/status answers 503 while a source is behind, body intact. Real incident
  // 2026-09-02: ENTSO-E maintenance, a user's status() rejected five times in
  // thirty seconds and told them nothing.
  const OUTAGE = {
    ok: false,
    ts: "2026-09-02T03:20:48Z",
    note: "At least one source is behind its expected publication lag.",
    sources: [
      { source: "eia", zones: 11, freshest_lag_hours: 21, stalest_lag_hours: 24, stale_after_hours: 36, ok: true },
      { source: "entsoe", zones: 33, freshest_lag_hours: 2, stalest_lag_hours: 76, stale_after_hours: 8, ok: false },
    ],
  };

  it("returns the report on a 503 instead of rejecting", async () => {
    const f = stubSequence(jsonResponse(OUTAGE, 503));
    const s = await client(f).status();
    assert.equal(s.ok, false);
    assert.deepEqual(s.sources.map((x) => x.source), ["eia", "entsoe"]);
    assert.equal(s.sources[1].ok, false);
    assert.equal(s.sources[1].stalestLagHours, 76);
  });

  it("still works on a 200", async () => {
    const f = stubSequence(jsonResponse({ ...OUTAGE, ok: true }));
    assert.equal((await client(f).status()).ok, true);
  });

  it("a 503 anywhere else still rejects with ApiError", async () => {
    const f = stubSequence(jsonResponse({ error: "upstream unavailable" }, 503));
    await assert.rejects(() => client(f).zones(), (err) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 503);
      return true;
    });
  });

  it("a 503 status with a non-JSON body still rejects", async () => {
    const f = stubSequence(new Response("<html>edge error</html>", { status: 503 }));
    await assert.rejects(() => client(f).status(), MalformedResponseError);
  });
});
