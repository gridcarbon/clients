// Live smoke test against https://api.gridcarbon.dev.
// Skipped unless GRIDCARBON_LIVE=1, so `npm test` stays hermetic.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GridCarbon, UnknownZoneError } from "../dist/index.js";

const live = process.env.GRIDCARBON_LIVE === "1";
const gc = new GridCarbon({ userAgent: "gridcarbon-js-smoketest/0.1.0" });

describe("live API", { skip: live ? false : "set GRIDCARBON_LIVE=1 to run" }, () => {
  it("lists 40+ zones including DE and GB", async () => {
    const zones = await gc.zones();
    assert.ok(zones.length >= 40, `only got ${zones.length} zones`);
    assert.ok(zones.some((z) => z.zone === "DE"));
    const gb = zones.find((z) => z.zone === "GB");
    assert.equal(gb.source, "uk-neso");
    assert.equal(gb.isLifecycle, false);
    assert.equal(gb.resolutionMinutes, 30);
    for (const z of zones) assert.ok(["entsoe", "eia", "uk-neso"].includes(z.source), z.source);
  });

  it("returns a plausible latest reading for every zone", async () => {
    const readings = await gc.latest();
    assert.ok(readings.length >= 40);
    for (const r of readings) {
      assert.ok(r.zone, "zone must be populated");
      assert.ok(r.ts instanceof Date && !Number.isNaN(r.ts.getTime()));
      assert.ok(r.gco2eqPerKwh >= 0 && r.gco2eqPerKwh < 2000, `${r.zone}=${r.gco2eqPerKwh}`);
      assert.ok(r.ts.getTime() <= Date.now() + 6 * 3600e3, `${r.zone} ts is far in the future`);
    }
  });

  it("returns one reading for a single zone", async () => {
    const de = await gc.latest("DE");
    assert.equal(de.zone, "DE");
    assert.equal(de.method, "computed:v1");
    assert.equal(de.isLifecycle, true);
  });

  it("flags GB as non-lifecycle", async () => {
    const gb = await gc.latest("GB");
    assert.match(gb.method, /^upstream:uk-neso:/);
    assert.equal(gb.isLifecycle, false);
  });

  it("404s on an unknown zone", async () => {
    await assert.rejects(() => gc.latest("ZZ"), (err) => {
      assert.ok(err instanceof UnknownZoneError);
      assert.equal(err.status, 404);
      return true;
    });
  });

  it("returns an ordered series inside the requested half-open window", async () => {
    const end = new Date();
    const start = new Date(end.getTime() - 12 * 3600e3);
    const series = await gc.series("DE", { start, end });
    assert.equal(series.zone, "DE");
    assert.equal(series.truncated, false);
    assert.equal(series.count, series.readings.length);
    assert.ok(series.count > 0, "DE should have data in the last 12h");
    let previous = -Infinity;
    for (const r of series.readings) {
      assert.equal(r.zone, "DE", "series items must be normalised to carry the zone");
      assert.ok(r.ts.getTime() > previous, "readings must be strictly ordered");
      assert.ok(r.ts >= start && r.ts < end, "half-open window [start, end)");
      previous = r.ts.getTime();
    }
  });

  it("returns an empty series for a window before the history starts", async () => {
    const series = await gc.series("DE", { start: "2026-01-01T00:00:00Z", end: "2026-01-02T00:00:00Z" });
    assert.deepEqual(series.readings, []);
    assert.equal(series.count, 0);
  });
});
