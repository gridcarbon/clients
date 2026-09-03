# gridcarbon

Python client for the [gridcarbon.dev](https://gridcarbon.dev) API — carbon intensity of
electricity grids across **45 zones** in Europe, the United States and Great Britain.

- **Zero runtime dependencies.** Standard library only (`urllib.request`).
- **Fully typed**, ships `py.typed`.
- Python **3.9+**.
- Synchronous and small: four methods, three value types.

> **Status: pre-alpha.** History reaches back to 2026-05-24, about three months. The API is
> unauthenticated and free, and the shape of these responses may still change.

## Install

```bash
pip install gridcarbon
```

No API key. No sign-up.

## 60-second example

```python
from gridcarbon import GridCarbon

gc = GridCarbon()

de = gc.latest("DE")
print(f"{de.zone}  {de.gco2eq_kwh} gCO2eq/kWh  at {de.ts:%Y-%m-%d %H:%M UTC}")
print(f"published {de.age.total_seconds() / 3600:.1f}h ago, lifecycle={de.is_lifecycle}")

# Cleanest grid right now, GB excluded because it is measured differently.
comparable = [r for r in gc.latest() if r.is_lifecycle]
cleanest = min(comparable, key=lambda r: r.gco2eq_kwh)
print(f"cleanest of {len(comparable)} comparable zones: "
      f"{cleanest.zone} at {cleanest.gco2eq_kwh} gCO2eq/kWh")

# Last 24 hours in France.
fr = gc.series("FR")
print(f"FR: {fr.count} points, avg {fr.average():.1f} gCO2eq/kWh, truncated={fr.truncated}")
```

Real output, run 2026-08-26 ~02:50 UTC:

```
DE  371.4 gCO2eq/kWh  at 2026-08-26 01:00 UTC
published 1.9h ago, lifecycle=True
cleanest of 44 comparable zones: CH at 18.6 gCO2eq/kWh
FR: 22 points, avg 46.0 gCO2eq/kWh, truncated=False
```

## Two things that will bite you

### 1. GB is not comparable with the other 44 zones

Every zone except GB is computed here from generation mix using **IPCC AR5 lifecycle**
emission factors. GB comes straight from NESO, which publishes **operational
(combustion-only)** factors — wind, solar, nuclear and hydro are counted as zero, and
nothing upstream of the smokestack is counted at all.

GB is therefore *structurally* lower than a lifecycle number for the same physical grid.
Putting GB in a league table with DE is comparing two different accounting systems.

Every `Reading` and `Zone` exposes `.is_lifecycle` so you can filter:

```python
comparable = [r for r in gc.latest() if r.is_lifecycle]   # 44 zones, GB dropped
```

In the example above GB was sitting at 114 gCO2eq/kWh — it would have won "cleanest grid"
outright on the raw number. It is excluded not because the number is wrong, but because it
answers a different question. **Compare GB to GB.**

### 2. "Latest" means most recently published, not now

Freshness varies enormously by source. Measured 2026-08-26 02:52 UTC:

```
GB        ts=2026-08-26 01:30Z  age=  1.4h
US-PJM    ts=2026-08-25 02:00Z  age= 24.9h
```

Europe typically runs 2–4 hours behind; US zones run 11–28 hours behind. That is normal
upstream publishing lag, not a fault. Always check `reading.age` before you present a value
as current, and never label a US figure "live".

## API

```python
GridCarbon(base_url="https://api.gridcarbon.dev", timeout=10.0,
           user_agent="gridcarbon-python/0.1.1")
```

The client is stateless, holds no connection, and is safe to share between threads.
If you build something on top of this, please append your own token to the user agent
(`"gridcarbon-python/0.1.1 myapp/2.1"`) so the operator can tell clients apart.

### `gc.health() -> bool`

```python
print(gc.health())
```

```
True
```

A cheap liveness probe against `/v1/health`. Returns `True` when the API reports itself
healthy, and raises the usual errors (below) when it cannot be reached at all.

### `gc.zones() -> list[Zone]`

```python
zones = gc.zones()
print(f"{len(zones)} zones")
for z in zones[:3] + [z for z in zones if z.zone == "GB"]:
    print(f"  {z.zone:<9} {z.name:<26} {z.source:<8} {z.resolution_min}min  lifecycle={z.is_lifecycle}")
```

```
45 zones
  AT        Austria                    entsoe   60min  lifecycle=True
  BE        Belgium                    entsoe   60min  lifecycle=True
  CH        Switzerland                entsoe   60min  lifecycle=True
  GB        Great Britain              uk-neso  30min  lifecycle=False
```

`Zone`: `.zone`, `.name`, `.source` (`entsoe` | `eia` | `uk-neso`), `.resolution_min`,
`.is_lifecycle`.

### `gc.latest()` / `gc.latest(zone)`

`gc.latest()` returns `list[Reading]`, one per zone. `gc.latest("DE")` returns a single
`Reading` and raises `UnknownZone` on an unknown id. Zone ids are case-insensitive.

`Reading` is a frozen dataclass:

| attribute | type | meaning |
|---|---|---|
| `.zone` | `str` | zone id — **always populated** |
| `.ts` | `datetime` | timezone-aware UTC instant the data describes |
| `.gco2eq_kwh` | `float` | grams CO₂-equivalent per kWh |
| `.method` | `str` | `computed:v1`, `upstream:uk-neso:actual`, `upstream:uk-neso:forecast` |
| `.is_lifecycle` | `bool` | `False` for GB — see above |
| `.is_forecast` | `bool` | `True` for NESO forecast rows |
| `.age` | `timedelta` | how long ago `.ts` was |

> The wire format is asymmetric: `/v1/intensity/latest` items carry `zone`, while
> `/v1/intensity` items do not (it lives on the envelope). This SDK normalises that away,
> so `.zone` is always set no matter which call produced the reading.

### `gc.series(zone, start=None, end=None, *, allow_truncated=False) -> Series`

`start` and `end` accept a `datetime` **or** an ISO-8601 string. Naive datetimes are read as
UTC (never local time); aware ones are converted. The window is half-open: `[start, end)`.
Defaults to the last 24 hours.

```python
s = gc.series("DE", start="2026-08-22T00:00:00Z", end="2026-08-22T06:00:00Z")
print(s)
for r in s:
    print(f"  {r.ts:%H:%M}Z  {r.gco2eq_kwh:6.1f}  {r.method}")
```

```
Series(zone='DE', count=6, start=2026-08-22T00:00:00+00:00, end=2026-08-22T06:00:00+00:00)
  00:00Z   382.6  computed:v1
  01:00Z   380.2  computed:v1
  02:00Z   369.7  computed:v1
  03:00Z   350.7  computed:v1
  04:00Z   318.7  computed:v1
  05:00Z   283.1  computed:v1
```

`Series` behaves like a read-only sequence — `len()`, indexing, slicing, iteration — plus
`.zone`, `.start`, `.end`, `.unit`, `.count`, `.truncated`, `.note`, `.is_lifecycle`
and `.average()`.

Timestamps parse strictly, on your machine, before anything is sent. This matters: the API
silently ignores an unparseable `from` and substitutes its own default window, which would
hand you 24 hours of data while you believed you had asked for a year.

```
ValueError: not a valid ISO-8601 timestamp: 'last tuesday'
```

#### Truncated series raise, they do not warn

The API caps a response at 5000 points and sets `truncated: true`. A silently short series
is the worst possible failure for this data — you get a plausible number that is simply
wrong. So `Series` **refuses to hand over its readings** until you acknowledge the cap:

```
Series for zone 'DE' is TRUNCATED: the API returned 5000 points and capped the result,
so this is NOT the full window [2026-08-21T00:00:00+00:00 .. 2026-08-26T00:00:00+00:00).
Iterating it would silently under-report.
Either narrow the window with start=/end=, or acknowledge the cap explicitly:
    gc.series('DE', ..., allow_truncated=True)
    # or: series.acknowledge_truncation()
Server note: Result capped at 5000 points. Narrow the window with 'from'/'to' to get the rest.
```

Iterating, indexing, slicing, `.readings` and `.average()` all raise `TruncatedSeriesError`.
`.truncated`, `.count`, `.note`, `len()` and `repr()` stay readable so you can diagnose the
problem without acknowledging anything.

*(That transcript is from the unit-test fixture, not a live call: at 45 zones and hourly
resolution, no window reachable today is anywhere near 5000 points. The path is covered by
tests so it will behave correctly once history is long enough to hit it.)*

### Errors

All errors derive from `GridCarbonError`.

| exception | when |
|---|---|
| `UnknownZone` | `latest(zone)` got a 404 — subclass of `ApiError`, carries `.zone` |
| `ApiError` | any other non-2xx — carries `.status`, `.message`, `.payload`, `.url` |
| `GridCarbonTimeout` | request exceeded `timeout` — also a builtin `TimeoutError` |
| `NetworkError` | DNS/TLS/refused — never reached an HTTP response |
| `TruncatedSeriesError` | reading a capped `Series` without acknowledging it |

```python
from gridcarbon import GridCarbon, UnknownZone, GridCarbonTimeout

try:
    gc.latest("ZZ")
except UnknownZone as e:
    print(f"UnknownZone: zone={e.zone!r} status={e.status} message={e.message!r}")
```

```
UnknownZone: zone='ZZ' status=404 message='unknown or empty zone: ZZ'
GridCarbonTimeout: request to https://api.gridcarbon.dev/v1/intensity/latest?zone=DE timed out after 0.001s
```

**One asymmetry to know about:** `series()` does *not* raise `UnknownZone`. The
`/v1/intensity` endpoint answers an unknown zone with `200` and an empty array, which is
indistinguishable from a window that simply has no data, so the SDK will not guess:

```
series('ZZ') -> count=0 truncated=False bool=False
```

Validate against `gc.zones()` if you need certainty.

## Polling

`latest` is edge-cached with a 5 minute TTL. Polling faster returns identical bytes.
One limit is configured: 60 requests per minute per IP, which returns 429 with a
`Retry-After` header. Cloudflare's limiter is deliberately permissive and eventually consistent — each isolate counts separately — so bursts well above that usually succeed. Measured 2026-09-01: 150 requests in 14 seconds from one IP, no 429. Treat 60/min as the intent, not the ceiling, and do not build against the headroom. It applies to every request — the Worker runs in front of the
cache — so honour the `Cache-Control` headers in your own client.

## Development

```bash
python -m unittest discover -s tests -t .     # 83 offline tests, no network
GRIDCARBON_LIVE=1 python -m unittest tests.test_live_smoke -v   # 10 live tests
```

The offline suite replaces `gridcarbon._http.urlopen` with a fake and asserts against
payloads captured verbatim from the live API. The live suite is skipped unless
`GRIDCARBON_LIVE=1`, and asserts only on shape and invariants, never on values.

### Is the data actually fresh?

`health()` only tells you the API answered. `status()` tells you whether collection
is keeping up, per upstream — which is the question that matters before you act on
a number.

```python
st = gc.status()
if not st.ok:
    for s in st.stale_sources():
        print(f"{s.source} is {s.stalest_lag_hours}h behind (normal is under {s.stale_after_hours}h)")
```

Thresholds differ by source on purpose: European feeds publish within hours, EIA is
routinely most of a day behind on its own schedule.

## Attribution

Use of the data carries an attribution obligation. If you publish figures derived from this
SDK, credit the upstream sources:

- **ENTSO-E Transparency Platform** — European zones.
- **U.S. Energy Information Administration (EIA)** — US zones.
- **NESO Carbon Intensity API** — the GB zone.

The EIA does not endorse this project, its methodology, or anything derived from it.
Neither do ENTSO-E or NESO.

## Licence

- **SDK source code:** MIT — see [LICENSE](LICENSE).
- **Data values** served by the API and returned through this SDK:
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) — see
  [DATA-LICENSE.md](DATA-LICENSE.md) for the attribution notice and upstream terms.

Author: gupeng &lt;hello@gridcarbon.dev&gt; · [gridcarbon.dev](https://gridcarbon.dev)
