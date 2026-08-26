"""gridcarbon -- a tiny, dependency-free client for the gridcarbon.dev API.

Carbon intensity of electricity grids in 45 zones across Europe and the US.

    >>> from gridcarbon import GridCarbon
    >>> gc = GridCarbon()
    >>> de = gc.latest("DE")
    >>> de.zone, de.is_lifecycle, isinstance(de.gco2eq_kwh, float)
    ('DE', True, True)

Two caveats worth reading before you plot anything:

* **GB is not comparable with the other 44 zones.** Its values come from NESO
  and use operational (combustion-only) emission factors, while every other
  zone uses IPCC AR5 lifecycle factors. Filter on ``Reading.is_lifecycle``
  before ranking or averaging across zones.
* **"latest" means most recently published, not now.** Freshness varies from
  about 2 hours (Europe) to 28 hours (US). Always look at ``Reading.age``.

Data: ENTSO-E Transparency Platform, U.S. Energy Information Administration
(EIA), and NESO Carbon Intensity API. See the README for attribution terms.
"""

from ._time import parse_iso
from .client import (
    DEFAULT_BASE_URL,
    DEFAULT_TIMEOUT,
    DEFAULT_USER_AGENT,
    GridCarbon,
    __version__,
)
from .errors import (
    ApiError,
    GridCarbonError,
    GridCarbonTimeout,
    NetworkError,
    TruncatedSeriesError,
    UnknownZone,
)
from .models import UNIT, Reading, Series, Zone

__all__ = [
    "GridCarbon",
    "Reading",
    "Series",
    "Zone",
    "UNIT",
    "GridCarbonError",
    "ApiError",
    "UnknownZone",
    "NetworkError",
    "GridCarbonTimeout",
    "TruncatedSeriesError",
    "DEFAULT_BASE_URL",
    "DEFAULT_TIMEOUT",
    "DEFAULT_USER_AGENT",
    "parse_iso",
    "__version__",
]
