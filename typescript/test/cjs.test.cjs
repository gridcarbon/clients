// Proves the CommonJS half of the dual build actually loads and works.
const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const path = require("node:path");
const fs = require("node:fs");

const pkgRoot = path.resolve(__dirname, "..");
const gridcarbon = require(path.join(pkgRoot, "dist", "index.cjs"));

describe("cjs build", () => {
  it("exposes the same public surface as the ESM build", () => {
    for (const name of [
      "GridCarbon",
      "GridCarbonError",
      "ApiError",
      "UnknownZoneError",
      "AbortError",
      "NetworkError",
      "MalformedResponseError",
      "TruncatedSeriesError",
      "VERSION",
      "DEFAULT_BASE_URL",
      "DEFAULT_TIMEOUT_MS",
      "SERIES_POINT_LIMIT",
    ]) {
      assert.ok(name in gridcarbon, `missing export: ${name}`);
    }
  });

  it("actually fetches through a stub", async () => {
    const gc = new gridcarbon.GridCarbon({
      fetch: async () =>
        new Response(
          JSON.stringify({
            unit: "gCO2eq/kWh",
            data: [{ zone: "DE", ts: "2026-08-26T01:00:00Z", gco2eq_kwh: 371.4, method: "computed:v1" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    const de = await gc.latest("DE");
    assert.equal(de.zone, "DE");
    assert.equal(de.gco2eqPerKwh, 371.4);
    assert.equal(de.isLifecycle, true);
    assert.ok(de.ts instanceof Date);
  });

  it("ships type declarations for both module systems", () => {
    for (const f of ["index.d.ts", "index.d.cts", "index.js", "index.cjs"]) {
      assert.ok(fs.existsSync(path.join(pkgRoot, "dist", f)), `dist/${f} is missing`);
    }
  });

  it("has zero runtime dependencies", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf8"));
    assert.equal(pkg.dependencies, undefined);
    assert.equal(pkg.peerDependencies, undefined);
    assert.equal(pkg.sideEffects, false);
  });

  it("bundles no bare imports into the published files", () => {
    for (const f of ["index.js", "index.cjs"]) {
      const src = fs.readFileSync(path.join(pkgRoot, "dist", f), "utf8");
      assert.equal(/\brequire\(["'](?!node:)/.test(src), false, `${f} requires something`);
      assert.equal(/^\s*import .* from ["']/m.test(src), false, `${f} imports something`);
    }
  });
});
