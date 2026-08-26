# gridcarbon

Zero-dependency TypeScript/JavaScript client for the [gridcarbon.dev](https://gridcarbon.dev)
grid carbon intensity API — 45 zones across Europe, the United States and Great Britain,
in grams of CO2-equivalent per kilowatt-hour.

- **No runtime dependencies.** Global `fetch` and nothing else.
- **Runs everywhere.** Node 18+, browsers, Cloudflare Workers, Deno, Bun.
- **ESM + CJS + full type declarations.** ~13 kB per build, no `node:` imports.
- **No API key.** The API is open and CORS-enabled.
- **Pre-alpha.** The API is young — history starts `2026-08-21` and the shape can still
  change. Read [Politeness](#politeness) before you depend on it.

```
npm install gridcarbon
```

## 60 seconds

```js
import { GridCarbon } from "gridcarbon";

const gc = new GridCarbon();

// 1. One zone, right now.
const de = await gc.latest("DE");
console.log(`${de.zone}  ${de.gco2eqPerKwh} gCO2eq/kWh  @ ${de.ts.toISOString()}  (${de.method})`);

// 2. Cleanest lifecycle-comparable zones. GB is excluded automatically:
//    its numbers come from NESO and use operational, not lifecycle, factors.
const all = await gc.latest();
const cleanest = all
  .filter((r) => r.isLifecycle)
  .sort((a, b) => a.gco2eqPerKwh - b.gco2eqPerKwh)
  .slice(0, 3);
console.log("\ncleanest comparable zones:");
for (const r of cleanest) console.log(`  ${r.zone.padEnd(12)} ${String(r.gco2eqPerKwh).padStart(6)}`);

// 3. A window. Always check `truncated` before averaging.
const end = new Date();
const start = new Date(end.getTime() - 6 * 3600 * 1000);
const series = await gc.series("DE", { start, end });
const mean = series.readings.reduce((s, r) => s + r.gco2eqPerKwh, 0) / series.count;
console.log(
  `\nDE last 6h: ${series.count} points, truncated=${series.truncated}, mean=${mean.toFixed(1)} gCO2eq/kWh`,
);
```

Real output, run against the live API at `2026-08-26T02:55Z`:

```
DE  371.4 gCO2eq/kWh  @ 2026-08-26T01:00:00.000Z  (computed:v1)

cleanest comparable zones:
  CH             18.6
  SE-1             21
  NO-5           24.5

DE last 6h: 5 points, truncated=false, mean=363.2 gCO2eq/kWh
```

## Two things that will bite you

### 1. GB is not comparable with the other 44 zones

Every zone except Great Britain is computed by the API from generation mix data using
**IPCC AR5 lifecycle** emission factors — they include construction, fuel supply chain and
decommissioning. GB values are passed straight through from NESO, which publishes
**operational** (combustion-only) factors. Lifecycle numbers are structurally higher.

Putting GB in the same league table as `DE` or `FR` is the single easiest way to
misread this data. Every `Reading` and `Zone` therefore carries an `isLifecycle` flag:

```js
const comparable = (await gc.latest()).filter((r) => r.isLifecycle); // 44 zones, GB dropped
```

```js
await gc.zones().then((z) => z.filter((x) => !x.isLifecycle));
```

```
[
  {
    zone: 'GB',
    name: 'Great Britain',
    source: 'uk-neso',
    resolutionMinutes: 30,
    isLifecycle: false
  }
]
```

### 2. `latest` means "newest published", not "now"

Upstream publication lag varies enormously by source. Always read `reading.ts` and
decide for yourself whether the value is fresh enough for what you are doing.

Measured live at `2026-08-26T02:55:39Z`, lag between the reading's timestamp and wall clock:

| source    | zones | min    | median | max    |
| --------- | ----- | ------ | ------ | ------ |
| `entsoe`  | 33    | 1.9 h  | 1.9 h  | 2.9 h  |
| `uk-neso` | 1     | 1.4 h  | 1.4 h  | 1.4 h  |
| `eia`     | 11    | 21.9 h | 23.9 h | 24.9 h |

US zones are roughly a day behind. That is EIA-930's publication schedule, not a bug.
GB can run *ahead* of wall clock because NESO also publishes a forecast — check
`method` for `upstream:uk-neso:forecast` versus `upstream:uk-neso:actual`.

## API

### `new GridCarbon(options?)`

| option        | default                        | meaning                                                                 |
| ------------- | ------------------------------ | ----------------------------------------------------------------------- |
| `baseUrl`     | `"https://api.gridcarbon.dev"` | API root. Trailing slashes are stripped.                                 |
| `fetch`       | global `fetch`                 | Custom implementation. Resolved at call time, so test doubles work.      |
| `timeoutMs`   | `10000`                        | Per-request timeout. `0` disables it.                                    |
| `userAgent`   | `gridcarbon-js/0.1.0 (…)`      | Sent on every request. Browsers ignore this header; other runtimes send it. |
| `onTruncated` | `"warn"`                       | `"warn"` \| `"throw"` \| `"ignore"` — see [Truncation](#truncation).     |

The client is stateless. Construct one and share it.

### `gc.zones(): Promise<Zone[]>`

```js
const zones = await gc.zones();
console.log(zones.length, zones[4]);
```

```
45
{
  zone: 'DE',
  name: 'Germany-Luxembourg',
  source: 'entsoe',
  resolutionMinutes: 60,
  isLifecycle: true
}
```

`source` is one of `"entsoe"`, `"eia"` or `"uk-neso"`. `resolutionMinutes` is 60 everywhere
except GB, which is 30.

### `gc.latest(): Promise<Reading[]>` / `gc.latest(zone): Promise<Reading>`

With no argument you get the newest reading for every zone. With a zone code you get
exactly one `Reading` (not an array), or an `UnknownZoneError`.

```js
console.log(await gc.latest("FR"));
console.log(await gc.latest("GB"));
```

```
{
  zone: 'FR',
  ts: 2026-08-26T00:00:00.000Z,
  gco2eqPerKwh: 48.3,
  method: 'computed:v1',
  isLifecycle: true
}
{
  zone: 'GB',
  ts: 2026-08-26T01:30:00.000Z,
  gco2eqPerKwh: 114,
  method: 'upstream:uk-neso:forecast',
  isLifecycle: false
}
```

Zone codes are trimmed and upper-cased for you, so `"de"` works.

### `gc.series(zone, options?): Promise<Series>`

A half-open `[start, end)` window, oldest reading first. Defaults to the last 24 hours.
`start` and `end` accept a `Date`, an ISO-8601 string, or epoch milliseconds.

```js
await gc.series("GB", { start: "2026-08-26T00:00:00Z", end: "2026-08-26T02:00:00Z" });
```

```
{
  zone: 'GB',
  start: 2026-08-26T00:00:00.000Z,
  end: 2026-08-26T02:00:00.000Z,
  readings: [
    {
      zone: 'GB',
      ts: 2026-08-26T00:00:00.000Z,
      gco2eqPerKwh: 92,
      method: 'upstream:uk-neso:actual',
      isLifecycle: false
    },
    {
      zone: 'GB',
      ts: 2026-08-26T00:30:00.000Z,
      gco2eqPerKwh: 92,
      method: 'upstream:uk-neso:actual',
      isLifecycle: false
    },
    {
      zone: 'GB',
      ts: 2026-08-26T01:00:00.000Z,
      gco2eqPerKwh: 93,
      method: 'upstream:uk-neso:actual',
      isLifecycle: false
    },
    {
      zone: 'GB',
      ts: 2026-08-26T01:30:00.000Z,
      gco2eqPerKwh: 114,
      method: 'upstream:uk-neso:forecast',
      isLifecycle: false
    }
  ],
  count: 4,
  truncated: false
}
```

The wire format puts `zone` on the *item* for `latest` but on the *envelope* for the
series endpoint. This SDK normalises that away: `reading.zone` is always populated, and a
`Reading` from `latest()` has exactly the same shape as one from `series()`.

A window with no data returns an empty array, never an error:

```js
await gc.series("DE", { start: "2026-01-01T00:00:00Z", end: "2026-01-02T00:00:00Z" });
// -> { count: 0, readings: [], truncated: false, ... }
```

Note that an **unknown** zone also returns an empty series rather than throwing — the API
answers `200` with no rows and does not distinguish "no such zone" from "no data in this
window". Validate with `gc.zones()` or `gc.latest(zone)` if you need that distinction.

### Truncation

The server caps a series at **5000 points** (`SERIES_POINT_LIMIT`). When it does,
`series.truncated` is `true` and `series.note` explains it — you are holding an
incomplete prefix of the window, so any sum or average over it is wrong.

The default `onTruncated: "warn"` makes that impossible to miss:

```
gridcarbon: series for DE was TRUNCATED at 5000 points - you are holding an incomplete window, so totals and averages over it will be wrong. Result capped at 5000 points. Narrow the window with 'from'/'to' to get the rest.
```

…while the returned object still tells you everything you need to page through it:

```
{
  count: 5000,
  truncated: true,
  note: "Result capped at 5000 points. Narrow the window with 'from'/'to' to get the rest."
}
```

If you would rather fail hard, ask for it:

```js
const gc = new GridCarbon({ onTruncated: "throw" }); // TruncatedSeriesError, .series has the partial data
await gc.series("DE", { start, end, onTruncated: "ignore" }); // or silence it per call
```

`series.truncated` is set in all three modes.

> The truncation examples above are reproduced from the test suite's stub, not the live
> API: history only starts `2026-08-21`, so no real window is long enough to reach 5000
> points yet. Everything else in this README is real pasted output.

## Errors

Everything this SDK throws extends `GridCarbonError`, so one `catch` separates API and
transport problems from bugs in your own code.

| class                    | when                                                              |
| ------------------------ | ----------------------------------------------------------------- |
| `GridCarbonError`        | base class; also raised for bad arguments                         |
| `ApiError`               | non-2xx response — carries `status`, `serverMessage`, `url`        |
| `UnknownZoneError`       | `extends ApiError` — unknown or empty zone code, carries `zone`    |
| `AbortError`             | timeout or your own `AbortSignal`; `name === "AbortError"`         |
| `NetworkError`           | request never reached the API; original error in `.cause`          |
| `MalformedResponseError` | 2xx with a body this SDK cannot use                                |
| `TruncatedSeriesError`   | only with `onTruncated: "throw"`; partial data in `.series`        |

```js
import { GridCarbon, UnknownZoneError, ApiError, AbortError } from "gridcarbon";

try {
  await gc.latest("ZZ");
} catch (err) {
  if (err instanceof UnknownZoneError) console.log(err.zone, err.status, err.serverMessage);
  else if (err instanceof ApiError) console.log(err.status, err.serverMessage);
  else throw err;
}
```

Real output:

```
UnknownZoneError | Unknown or empty zone: ZZ. Call zones() for the list of supported zones. | status=404 zone=ZZ | instanceof ApiError: true | instanceof UnknownZoneError: true
AbortError | Request to https://api.gridcarbon.dev/v1/zones timed out after 1 ms | timeoutMs=1 | instanceof AbortError: true
```

Cancel a request yourself with a standard signal:

```js
const controller = new AbortController();
setTimeout(() => controller.abort(), 500);
await gc.zones({ signal: controller.signal }); // -> AbortError
```

## Runtimes

The bundle references only `fetch`, `AbortController`, `URLSearchParams`, `setTimeout` and
`globalThis`. There are no `node:` imports and no bare imports of any kind.

| runtime            | status                                             |
| ------------------ | -------------------------------------------------- |
| Node 18+           | verified on Node 22 (ESM `import` and CJS `require`) |
| Bun                | verified on Bun 1.3 (ESM and CJS)                   |
| Deno               | supported — `npm:gridcarbon`                        |
| Cloudflare Workers | supported                                          |
| Browsers           | supported — the API sends `Access-Control-Allow-Origin: *` |

In a browser, the `User-Agent` header is a forbidden header name and is silently dropped
by the platform. That is expected and harmless.

## Politeness

The API is pre-alpha, has no rate limits yet, and edge-caches `latest` for 5 minutes.
**Do not poll faster than once every 5 minutes** — you will only get the cached response
anyway. History begins `2026-08-21`.

## Attribution

Using this data obliges you to credit the upstream sources. Reproduce this notice
wherever you surface the numbers:

> Electricity data from the [ENTSO-E Transparency Platform](https://transparency.entsoe.eu/),
> the [U.S. Energy Information Administration](https://www.eia.gov/) (EIA), and the
> [NESO Carbon Intensity API](https://carbonintensity.org.uk/).
> Carbon intensity computed by [gridcarbon.dev](https://gridcarbon.dev).

The EIA does not endorse, certify or have any involvement with this project or anything
built on it.

## Licence

Source code: **MIT** — see [LICENSE](./LICENSE).

Data values retrieved from the API: **CC BY 4.0**.

## Links

- API and docs: <https://gridcarbon.dev>
- Issues: <mailto:hello@gridcarbon.dev>
