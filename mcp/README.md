# gridcarbon-mcp

An [MCP](https://modelcontextprotocol.io) server that gives an AI agent the carbon
intensity of the electricity grid — **gCO2eq/kWh, lower is cleaner** — for 45 zones
across Europe, the United States and Great Britain.

No API key. No account. No configuration.

```bash
npx gridcarbon-mcp
```

Backed by [api.gridcarbon.dev](https://api.gridcarbon.dev). Data from the ENTSO-E
Transparency Platform, the U.S. Energy Information Administration and NESO.

---

## Install

### Claude Code

```bash
claude mcp add gridcarbon -- npx -y gridcarbon-mcp
```

Add `-s user` to make it available in every project instead of just the current one:

```bash
claude mcp add -s user gridcarbon -- npx -y gridcarbon-mcp
```

### Claude Desktop

Edit `claude_desktop_config.json`
(macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`,
Windows: `%APPDATA%\Claude\claude_desktop_config.json`) and add:

```json
{
  "mcpServers": {
    "gridcarbon": {
      "command": "npx",
      "args": ["-y", "gridcarbon-mcp"]
    }
  }
}
```

Restart Claude Desktop.

### Anything else that speaks MCP over stdio

```json
{ "command": "npx", "args": ["-y", "gridcarbon-mcp"] }
```

The only optional setting is `GRIDCARBON_API_URL`, which points the server at a
different API base URL (for local development against a Worker on `localhost:8787`).

---

## Tools

| Tool | What it does |
| :--- | :--- |
| `get_carbon_intensity` | Newest published intensity for one zone, with its timestamp and how stale it is |
| `get_intensity_history` | Hourly series over a window, plus min / max / mean / cleanest / dirtiest |
| `list_zones` | The 45 covered zones, each with its source, resolution and comparability |
| `compare_zones` | Rank zones cleanest-first, with Great Britain handled correctly (see below) |

Every tool is read-only. Every value comes back with its interval timestamp, its age in
minutes, and a plain-English age like `"2h 57m ago"` — because the most likely way to
misuse this data is to report a 24-hour-old US number as "right now".

---

## Example prompts

These work as written once the server is installed:

- *"What's the carbon intensity of the French grid right now?"*
- *"Is Sweden's grid cleaner than Poland's at the moment?"*
- *"Rank the five cleanest electricity grids you have data for."*
- *"I need to run a 6-hour GPU job. Of Germany, France and Ireland, which grid is cleanest right now, and how old is that number?"*
- *"Show me how Germany's grid carbon intensity moved over the last 24 hours."*
- *"What was the cleanest hour in Spain yesterday?"*
- *"Which US grid is dirtiest today, and how far behind is EIA's data?"*
- *"Do you cover Japan?"* — it will tell you no, instead of guessing.

---

## What it actually returns

All output below is the literal `content[0].text` of a `tools/call`, captured from the
published tarball talking to the live API at **2026-08-26 03:11 UTC**. Nothing here is
invented. The numbers move every hour; the field names and shapes do not.

### `get_carbon_intensity` — `{ "zone": "FR" }`

```markdown
## FR — France
**49 gCO2eq/kWh** (very clean)
- Interval start (UTC): `2026-08-26T01:00:00Z` (60-minute interval)
- Age: 2h 11m ago (131 min, normal)
- Method: `computed:v1` · source: entsoe

As of 2026-08-26 01:00 UTC — the most recent published interval, 2h 11m ago — the carbon intensity of FR (France) was 49 gCO2eq/kWh.

_Newest published value; the API caches /latest for 5 minutes. "Latest" means newest published, not "now"._
```

The same call for `US-ERCOT`, one minute later:

```markdown
## US-ERCOT — ERCOT (Texas)
**349.9 gCO2eq/kWh** (fossil-heavy)
- Interval start (UTC): `2026-08-25T03:00:00Z` (60-minute interval)
- Age: 24h 11m ago (1451 min, normal)
- Method: `computed:v1` · source: eia

As of 2026-08-25 03:00 UTC — the most recent published interval, 24h 11m ago — the carbon intensity of US-ERCOT — ERCOT (Texas) was 349.9 gCO2eq/kWh.

_Newest published value; the API caches /latest for 5 minutes. "Latest" means newest published, not "now"._
```

That number is **more than a day old**, and the tool says so in three places rather than
letting an agent call it "current". `freshness` is still `normal`, because a day of lag
is normal for EIA — staleness is judged against each source's own habits.

### `compare_zones` — `{ "zones": ["DE", "FR", "PL", "SE-3", "GB"] }`

```markdown
# Carbon intensity ranking (cleanest first, gCO2eq/kWh, lower is cleaner)

Basis: IPCC AR5 lifecycle factors (GB excluded: operational factors)

| # | Zone | Name | Value | Band | Interval start (UTC) | Age |
| -: | :--- | :--- | ----: | :--- | :------------------- | :-- |
| 1 | `SE-3` | Sweden SE3 | 33.2 | very clean | 2026-08-26T00:00:00Z | 3h 11m ago |
| 2 | `FR` | France | 49 | very clean | 2026-08-26T01:00:00Z | 2h 11m ago |
| 3 | `DE` | Germany-Luxembourg | 377.7 | fossil-heavy | 2026-08-26T02:00:00Z | 1h 11m ago |
| 4 | `PL` | Poland | 635 | very fossil-heavy | 2026-08-26T02:00:00Z | 1h 11m ago |

Of 4 zone(s) ranked, SE-3 (Sweden SE3) is cleanest at 33.2 gCO2eq/kWh (3h 11m ago) and PL (Poland) is highest at 635 gCO2eq/kWh (1h 11m ago). Each figure is that zone's newest published interval, not a common moment.

## Not ranked
- **GB** (Great Britain) — reported value **114 gCO2eq/kWh** at 2026-08-26 02:30 UTC (41m ago)
  - Not ranked: GB values come from NESO and use OPERATIONAL (combustion-only) emission factors, not the IPCC AR5 lifecycle factors used for the other 44 zones. GB numbers are systematically lower and MUST NOT be compared or ranked against other zones. Its value of 114 gCO2eq/kWh at 2026-08-26T02:30:00Z is reported here so it is not lost, but placing it in the same ranking would misrepresent it as cleaner than it is on a like-for-like basis.

> ⚠️ GB is in the requested set but is NOT in the ranking. Its value is in "excluded_from_ranking" — report it separately, with the reason.
```

Note what did **not** happen: GB was not quietly dropped, and it was not allowed to win
the ranking on 114 — a number that is not on the same basis as the other four.

### `compare_zones` — `{ "limit": 5 }` (rank every zone, keep the cleanest five)

```markdown
# Carbon intensity ranking (cleanest first, gCO2eq/kWh, lower is cleaner)

Basis: IPCC AR5 lifecycle factors (GB excluded: operational factors)

| # | Zone | Name | Value | Band | Interval start (UTC) | Age |
| -: | :--- | :--- | ----: | :--- | :------------------- | :-- |
| 1 | `CH` | Switzerland | 18.7 | very clean | 2026-08-26T01:00:00Z | 2h 11m ago |
| 2 | `SE-1` | Sweden SE1 | 21.3 | very clean | 2026-08-26T01:00:00Z | 2h 11m ago |
| 3 | `NO-5` | Norway NO5 | 24.5 | very clean | 2026-08-26T00:00:00Z | 3h 11m ago |
| 4 | `NO-3` | Norway NO3 | 26.2 | very clean | 2026-08-26T00:00:00Z | 3h 11m ago |
| 5 | `NO-2` | Norway NO2 | 27.7 | very clean | 2026-08-26T00:00:00Z | 3h 11m ago |

Of 5 zone(s) ranked, CH (Switzerland) is cleanest at 18.7 gCO2eq/kWh (2h 11m ago) and NO-2 (Norway NO2) is highest at 27.7 gCO2eq/kWh (3h 11m ago). Each figure is that zone's newest published interval, not a common moment.

[… GB "Not ranked" block, as above …]

> ⚠️ GB is covered but is NOT in the ranking. Its value is in "excluded_from_ranking" — report it separately, with the reason.
> ⚠️ limit=5 kept only the 5 cleanest of 44 zones that have data; 39 further zone(s) were ranked but not returned. Every figure below — cleanest, dirtiest, spread, observation times — describes the returned rows only, not the full set.
```

Every superlative in that answer — `cleanest`, `dirtiest`, `spread_gco2eq_kwh`,
`observation_times` — is scoped to the five rows you can actually see, and
`omitted_by_limit` says how many were dropped. The tool never names a zone that is not
in its own table.

### `get_intensity_history` — `{ "zone": "DE", "from": "2026-08-25T18:00:00Z", "to": "2026-08-26T00:00:00Z" }`

```markdown
# DE — Germany-Luxembourg: 2026-08-25 18:00 UTC → 2026-08-26 00:00 UTC

6 interval(s), unit gCO2eq/kWh, lower is cleaner.

- Mean **363.6**, min **356.5**, max **380.7**
- Cleanest interval: 2026-08-25 22:00 UTC at 356.5
- Dirtiest interval: 2026-08-25 18:00 UTC at 380.7
- First → last: 380.7 → 360.5 (-5.3%)

| Interval start (UTC) | gCO2eq/kWh | method |
| :------------------- | ------------: | :----- |
| 2026-08-25T18:00:00Z | 380.7 | computed:v1 |
| 2026-08-25T19:00:00Z | 365 | computed:v1 |
| 2026-08-25T20:00:00Z | 359.1 | computed:v1 |
| 2026-08-25T21:00:00Z | 359.6 | computed:v1 |
| 2026-08-25T22:00:00Z | 356.5 | computed:v1 |
| 2026-08-25T23:00:00Z | 360.5 | computed:v1 |

> ⚠️ The newest interval in this window starts 2026-08-25T23:00:00Z (4h 11m ago). That is the end of the published data, not the present moment.
```

### `list_zones` — `{ "source": "uk-neso" }`

```markdown
# Covered zones (1 of 45)

| Zone | Name | Source | Res (min) | Factors | Typical lag |
| :--- | :--- | :----- | --------: | :------ | :---------- |
| `GB` | Great Britain | uk-neso | 30 | operational ⚠️ | ~2h |

- **uk-neso** — NESO Carbon Intensity API, passed through unchanged. OPERATIONAL (combustion-only) factors — NOT comparable with the other 44 zones. Typically 1-2 hours behind, and the newest interval may be a forecast.

> 44 of 45 zones use IPCC AR5 lifecycle emission factors. GB values come from NESO and use OPERATIONAL (combustion-only) emission factors, not the IPCC AR5 lifecycle factors used for the other 44 zones. GB numbers are systematically lower and MUST NOT be compared or ranked against other zones.
> typical_lag_hours is the usual publication delay, not a guarantee. Always read the ts and age returned by get_carbon_intensity before calling a value current.
> History starts 2026-05-24; nothing earlier exists.
> Attribution required: ENTSO-E Transparency Platform / U.S. Energy Information Administration (EIA) / NESO Carbon Intensity API. EIA does not endorse this service.
```

---

## Caveats — please read these

**1. Great Britain is not comparable with anything else.**
GB comes from NESO's own Carbon Intensity API, which uses **operational**
(combustion-only) emission factors. The other 44 zones are computed here from the
published generation mix using **IPCC AR5 lifecycle** factors, which also count plant
construction and the fuel supply chain. GB's numbers are therefore systematically lower
for the same physical grid. `compare_zones` keeps GB out of rankings by default and
reports it separately with the reason; `include_gb_in_ranking: true` ranks it anyway but
flags every affected row, the comparison basis and a top-level warning. This is the
single most likely way to misread the data.

**2. "Latest" means newest published, not "now".**
European (ENTSO-E) zones typically run 2–4 hours behind real time. US (EIA) zones run
11–28 hours behind. Great Britain runs 1–2 hours behind and its newest interval may be a
NESO *forecast* (`method: "upstream:uk-neso:forecast"`) rather than a settled actual.
Every reading carries `ts`, `age_minutes`, `age_human` and a `freshness` classification
that is relative to what is normal for that source — a 24-hour-old EIA value is
`"normal"`, not `"stale"`.

**3. Coverage is Europe, the US and Great Britain only.**
45 zones. No Canada, Australia, Japan, China, India, Latin America or Africa. Unknown
zone codes return an error with near matches rather than a plausible-looking substitute.

**4. History starts 2026-08-21.** Nothing exists before that. Missing intervals are
gaps, not zeros — do not interpolate them.

**5. Pre-alpha.** The API is young. It is rate-limited to 60 requests per minute per IP — loosely, since Cloudflare's limiter is permissive by design — and `/latest` is
edge-cached with a 5-minute TTL, so there is nothing to gain from polling faster than
that. The `/v1/intensity` endpoint caps a response at 5000 points; when that happens the
tool sets `server_truncated: true` and says loudly that the series is incomplete.

---

## Attribution

Using this data carries an attribution obligation. If you surface these values to an end
user, credit:

- **ENTSO-E Transparency Platform** — European generation mix
- **U.S. Energy Information Administration (EIA)** — US generation mix (EIA-930)
- **NESO Carbon Intensity API** — Great Britain

The EIA does not endorse this package, the gridcarbon service, or any use made of the
data.

Lifecycle emission factors are IPCC AR5 medians. Methodology:
<https://gridcarbon.dev>.

## Licence

- **Source code:** MIT — see [LICENSE](./LICENSE).
- **Data values:** CC BY 4.0 — see [DATA-LICENSE.md](./DATA-LICENSE.md) for the
  attribution notice, the upstream sources and their non-endorsement statements.

## Development

```bash
npm install
npm run build          # tsc -> dist/, chmod +x dist/index.js
npm test               # end-to-end stdio smoke test against the live API
npm test -- --raw      # also dumps the literal tools/list response
```

`scripts/smoke-test.mjs` spawns `node dist/index.js` and speaks raw newline-delimited
JSON-RPC to it exactly as an MCP client would — `initialize`,
`notifications/initialized`, `tools/list`, then `tools/call` for every tool including
the failure paths (unknown zone, inverted window, pre-coverage window). It also asserts
that nothing but JSON-RPC ever reaches stdout.

Most of it runs against the live API. The one thing the live API cannot currently
produce is a truncated response — there is not yet enough history to hit the 5000-point
cap — so that check spawns a second server against a throwaway local HTTP stub on an
ephemeral port and asserts that `truncated: true` surfaces as `server_truncated` plus an
`INCOMPLETE SERIES` warning carrying the API's own note.

Direct runtime dependencies are `@modelcontextprotocol/sdk` and `zod` (which the SDK
requires for tool schemas). Be aware that the SDK drags in its own transitive tree — a
clean `npm install` of this package pulls roughly 95 packages, including `express` and
`cors`, which this server never uses because it only ever speaks stdio. All HTTP this
package itself performs uses Node's built-in `fetch`; Node 18+ is required.

### Before the first publish

- `mcpName` in `package.json` is `dev.gridcarbon/gridcarbon-mcp`. Claiming that
  namespace in the official MCP registry requires proving control of `gridcarbon.dev`
  with a DNS TXT record; do that before submitting, or switch the namespace to an
  `io.github.<owner>/…` form and verify via GitHub instead.
- `package.json` deliberately has no `repository` field yet — there is no public source
  repository. Add it when one exists rather than shipping a URL that 404s.

---

Author: hello@gridcarbon.dev · Homepage: <https://gridcarbon.dev>
