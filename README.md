# gridcarbon clients

Official client libraries for the [gridcarbon](https://gridcarbon.dev) API — hourly
electricity grid carbon intensity in gCO<sub>2</sub>eq/kWh for 45 zones across Europe,
the United States and Great Britain.

No API key. No signup. Open CORS.

```bash
curl -s "https://api.gridcarbon.dev/v1/intensity/latest?zone=FR"
```
```json
{"unit":"gCO2eq/kWh","data":[{"zone":"FR","ts":"2026-08-26T01:00:00Z","gco2eq_kwh":49,"method":"computed:v1"}]}
```

| Package | Registry | Install |
| :-- | :-- | :-- |
| [`python/`](python/) | PyPI `gridcarbon` | `pip install gridcarbon` |
| [`typescript/`](typescript/) | npm `gridcarbon` | `npm install gridcarbon` |
| [`mcp/`](mcp/) | npm `gridcarbon-mcp` | `npx gridcarbon-mcp` |

Both SDKs have **zero runtime dependencies** — the Python one uses `urllib`, the
TypeScript one uses global `fetch`. The MCP server depends on the official
MCP SDK; that cost is documented in [its README](mcp/README.md).

## Two things to know before you use the numbers

**Great Britain is measured on a different basis.** GB figures come from NESO and use
*operational* (combustion-only) emission factors — wind, solar, nuclear and hydro count
as zero. Every other zone uses IPCC AR5 *lifecycle* factors, where those sources are not
zero. GB is therefore structurally lower than a lifecycle number for the same physical
grid. **Do not rank GB against the other 44 zones.** Both SDKs expose this as
`is_lifecycle` / `isLifecycle` on every reading, and the MCP server excludes GB from
rankings with an explanation rather than silently mixing bases.

**"Latest" means newest published, not now.** European zones typically run 2–4 hours
behind and US zones 11–28 hours behind, because that is when the upstream operators
publish. Every reading carries its interval start; use it rather than assuming the
value is current.

The full method, the complete emission factor table, and a candid list of known biases
are at [gridcarbon.dev/methodology](https://gridcarbon.dev/methodology).

## Status

Pre-alpha. The archive has been backfilled to 2026-05-24 — about three months — and grows
hourly. One limit is configured: 60 requests per minute per IP, loosely enforced — Cloudflare's is deliberately permissive and eventually consistent — each isolate counts separately — so bursts well above that usually succeed. Measured 2026-09-01: 150 requests in 14 seconds from one IP, no 429. Treat 60/min as the intent, not the ceiling, and do not build against the headroom.
yet — please do not poll faster than every five minutes, which is the edge-cache TTL on
`/v1/intensity/latest`. Breaking changes are possible before 1.0; they will be noted in
each package's changelog.

## Attribution

The data these clients retrieve is derived from:

- **ENTSO-E Transparency Platform** — European generation by production type
- **U.S. Energy Information Administration (EIA)** — EIA-930 hourly generation by fuel type
- **NESO Carbon Intensity API** — Great Britain

gridcarbon is not endorsed by, sponsored by, or affiliated with any of these
organisations. If you redistribute or display these values, carry the same attribution.

## Licence

Client code in this repository: [MIT](LICENSE).
The derived intensity values served by the API: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

The data terms, the required attribution notice, the upstream sources and their
non-endorsement statements are all in [DATA-LICENSE.md](DATA-LICENSE.md).

## Contributing

Corrections to the method are genuinely welcome — especially from people who work with
grid data professionally. The emission factors and their known biases are documented
openly precisely so they can be argued with.

Issues and pull requests are the best channel. This repository holds the client
libraries; the API backend is not open source.
