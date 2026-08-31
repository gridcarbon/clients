# Data licence and attribution

The MIT licence in [LICENSE](LICENSE) covers the **source code** in this repository.
It does not cover the **numbers**. Those are licensed separately, and carry an
attribution obligation.

## The values

Carbon intensity values served by the gridcarbon.dev API — and returned through the
Python SDK, the TypeScript SDK and the MCP server in this repository — are published
under **[Creative Commons Attribution 4.0 International (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/)**.

You may use them commercially, redistribute them, and build on them. You must credit
the sources.

## Required attribution

If you publish, display or redistribute figures derived from this data, reproduce a
notice equivalent to:

> Electricity data from the [ENTSO-E Transparency Platform](https://transparency.entsoe.eu/),
> the [U.S. Energy Information Administration](https://www.eia.gov/) (EIA), and the
> [NESO Carbon Intensity API](https://carbonintensity.org.uk/). Carbon intensity
> computed by [gridcarbon.dev](https://gridcarbon.dev).

## Upstream sources and their terms

| Source | Coverage | Terms |
| :--- | :--- | :--- |
| **ENTSO-E Transparency Platform** | European generation by production type | [ENTSO-E terms](https://transparency.entsoe.eu/content/static_content/Static%20content/terms%20and%20conditions/terms%20and%20conditions.html) |
| **U.S. Energy Information Administration (EIA-930)** | US hourly generation by fuel type | US Government work, public domain |
| **NESO Carbon Intensity API** | Great Britain | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |

Upstream terms govern the upstream data. Where they are stricter than CC BY 4.0, they
win.

## Non-endorsement

**The EIA does not endorse this repository, the gridcarbon service, or any use made of
the data.** Neither does ENTSO-E, and neither does NESO. This project is not affiliated
with any of them.

## Method

The intensity values are derived, not reported: generation by fuel type is multiplied by
IPCC AR5 lifecycle emission factors. Every factor, every assumption and every known
weakness is published at <https://gridcarbon.dev/methodology>. Read it before you rely
on a number.
