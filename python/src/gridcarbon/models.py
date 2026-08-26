"""Typed value objects returned by :class:`gridcarbon.GridCarbon`."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterator, List, Optional, Tuple, Union, overload

from ._time import parse_iso
from .errors import TruncatedSeriesError

__all__ = ["Zone", "Reading", "Series", "UNIT"]

#: The unit every intensity value is expressed in.
UNIT = "gCO2eq/kWh"

#: Methods that are *not* lifecycle-based. See :attr:`Reading.is_lifecycle`.
_OPERATIONAL_PREFIX = "upstream:uk-neso"


@dataclass(frozen=True)
class Zone:
    """A grid zone the API publishes data for."""

    zone: str
    """Zone id, e.g. ``"DE"``, ``"DK-1"``, ``"US-CAISO"``."""

    name: str
    """Human-readable name, e.g. ``"Germany-Luxembourg"``."""

    source: str
    """Upstream data source: ``"entsoe"``, ``"eia"`` or ``"uk-neso"``."""

    resolution_min: int
    """Publishing interval in minutes (60 everywhere except GB, which is 30)."""

    @property
    def is_lifecycle(self) -> bool:
        """Whether this zone's values use lifecycle emission factors.

        ``False`` for GB (``uk-neso``), whose values are combustion-only. See
        :attr:`Reading.is_lifecycle` for why this matters.
        """
        return self.source != "uk-neso"

    @classmethod
    def from_json(cls, payload: Dict[str, Any]) -> "Zone":
        return cls(
            zone=str(payload["zone"]),
            name=str(payload.get("name", "")),
            source=str(payload.get("source", "")),
            resolution_min=int(payload.get("resolution_min", 0)),
        )


@dataclass(frozen=True)
class Reading:
    """One carbon-intensity observation for one zone at one instant."""

    zone: str
    """Zone id. Always populated, including for readings that came from the
    series endpoint, where the wire format carries the zone on the envelope
    rather than on each item."""

    ts: datetime
    """Timezone-aware UTC timestamp of the observation.

    This is the instant the *data* describes, not the moment you fetched it.
    Zones lag reality by hours -- see :attr:`age`."""

    gco2eq_kwh: float
    """Carbon intensity in grams CO2-equivalent per kilowatt-hour."""

    method: str
    """How the value was derived: ``"computed:v1"``,
    ``"upstream:uk-neso:actual"`` or ``"upstream:uk-neso:forecast"``."""

    @property
    def is_lifecycle(self) -> bool:
        """``True`` if this value uses IPCC AR5 *lifecycle* emission factors.

        ``False`` for the GB zone, whose values come straight from NESO and use
        **operational (combustion-only)** factors. Operational values ignore
        fuel extraction, plant construction and transport, so they run
        systematically lower.

        **A ``False`` reading is not numerically comparable with a ``True``
        one.** Any code that ranks, averages or diffs across zones must filter
        on this property first, or it will conclude that GB is far cleaner than
        it is on a like-for-like basis.
        """
        return not self.method.startswith(_OPERATIONAL_PREFIX)

    @property
    def is_forecast(self) -> bool:
        """``True`` if the value is a forecast rather than a settled figure.

        Only GB ever reports forecasts (``upstream:uk-neso:forecast``).
        """
        return self.method.endswith(":forecast")

    @property
    def age(self) -> timedelta:
        """How long ago :attr:`ts` was, measured from now (UTC).

        ``latest`` means *most recently published*, not *now*. European zones
        typically run 2-4 hours behind and US zones 11-28 hours behind, so this
        is routinely several hours even when the API is perfectly healthy.
        """
        return datetime.now(timezone.utc) - self.ts

    @classmethod
    def from_json(cls, payload: Dict[str, Any], *, zone: Optional[str] = None) -> "Reading":
        """Build a Reading from either wire shape.

        The ``latest`` items carry ``zone``; the ``series`` items do not and
        rely on ``zone`` being supplied from the envelope.
        """
        raw_zone = payload.get("zone", zone)
        if raw_zone is None:
            raise ValueError("reading has no zone and none was supplied: {0!r}".format(payload))
        return cls(
            zone=str(raw_zone),
            ts=parse_iso(str(payload["ts"])),
            # The API emits bare integers for round values (GB was 114, not
            # 114.0), so coerce rather than trusting the JSON type.
            gco2eq_kwh=float(payload["gco2eq_kwh"]),
            method=str(payload.get("method", "")),
        )


class Series:
    """An ordered run of :class:`Reading` for one zone over a time window.

    Behaves like a read-only sequence -- ``len()``, indexing, slicing and
    iteration all work::

        s = gc.series("DE")
        len(s), s[0], s[-1], s[:3], [r.gco2eq_kwh for r in s]

    **Truncation.** The API caps a response at 5000 points and sets
    :attr:`truncated`. When that happens this class *raises*
    :class:`~gridcarbon.TruncatedSeriesError` on any attempt to read the
    readings, rather than warning. A warning is too easy to miss in a script
    that is summing a year of data, and a silently short series produces a
    plausible-looking wrong number. To proceed anyway, acknowledge the cap::

        s = gc.series("DE", start=..., end=..., allow_truncated=True)
        # or
        s = gc.series("DE", start=..., end=...).acknowledge_truncation()

    :attr:`truncated`, :attr:`count`, :attr:`note`, ``len()`` and ``repr()``
    stay usable on a truncated series so you can diagnose it without
    acknowledging anything.
    """

    __slots__ = (
        "zone",
        "start",
        "end",
        "unit",
        "count",
        "truncated",
        "note",
        "_readings",
        "_acknowledged",
    )

    def __init__(
        self,
        zone: str,
        start: datetime,
        end: datetime,
        readings: Tuple[Reading, ...],
        *,
        count: Optional[int] = None,
        truncated: bool = False,
        note: Optional[str] = None,
        unit: str = UNIT,
        acknowledged: bool = False,
    ) -> None:
        self.zone = zone
        self.start = start
        """Start of the requested window (inclusive), UTC."""
        self.end = end
        """End of the requested window (exclusive), UTC."""
        self.unit = unit
        self.count = count if count is not None else len(readings)
        """Number of readings returned. Equals ``len(self)``."""
        self.truncated = truncated
        """``True`` if the API capped the result at 5000 points."""
        self.note = note
        """The server's explanatory note, present only when truncated."""
        self._readings = readings
        self._acknowledged = acknowledged

    # -- truncation gate ---------------------------------------------------

    def acknowledge_truncation(self) -> "Series":
        """Mark the cap as understood and return ``self``, enabling reads.

        No-op on a series that was not truncated.
        """
        self._acknowledged = True
        return self

    def _check(self) -> None:
        if self.truncated and not self._acknowledged:
            raise TruncatedSeriesError(self)

    # -- sequence protocol -------------------------------------------------

    def __iter__(self) -> Iterator[Reading]:
        self._check()
        return iter(self._readings)

    @overload
    def __getitem__(self, index: int) -> Reading: ...

    @overload
    def __getitem__(self, index: slice) -> List[Reading]: ...

    def __getitem__(self, index: Union[int, slice]) -> Union[Reading, List[Reading]]:
        self._check()
        if isinstance(index, slice):
            return list(self._readings[index])
        return self._readings[index]

    def __len__(self) -> int:
        # Deliberately not gated: knowing how many points came back is
        # diagnostic information, not the data itself.
        return len(self._readings)

    def __bool__(self) -> bool:
        return bool(self._readings)

    @property
    def readings(self) -> Tuple[Reading, ...]:
        """All readings as a tuple. Subject to the truncation gate."""
        self._check()
        return self._readings

    # -- conveniences ------------------------------------------------------

    @property
    def is_lifecycle(self) -> bool:
        """``True`` if every reading uses lifecycle factors (i.e. not GB)."""
        return all(r.is_lifecycle for r in self._readings)

    def average(self) -> Optional[float]:
        """Unweighted mean intensity, or ``None`` when empty.

        Unweighted: it assumes every reading covers an equal interval, which
        holds within a zone but not across zones. Subject to the truncation
        gate, since averaging a capped window is exactly the mistake the gate
        exists to prevent.
        """
        self._check()
        if not self._readings:
            return None
        return sum(r.gco2eq_kwh for r in self._readings) / len(self._readings)

    def __repr__(self) -> str:
        flag = ", TRUNCATED" if self.truncated else ""
        return "Series(zone={0!r}, count={1}, start={2}, end={3}{4})".format(
            self.zone,
            self.count,
            self.start.isoformat(),
            self.end.isoformat(),
            flag,
        )

    @classmethod
    def from_json(
        cls, payload: Dict[str, Any], *, acknowledged: bool = False
    ) -> "Series":
        zone = str(payload.get("zone", ""))
        items = payload.get("data") or []
        readings = tuple(Reading.from_json(item, zone=zone) for item in items)
        return cls(
            zone=zone,
            start=parse_iso(str(payload["from"])),
            end=parse_iso(str(payload["to"])),
            readings=readings,
            count=int(payload.get("count", len(readings))),
            truncated=bool(payload.get("truncated", False)),
            note=payload.get("note"),
            unit=str(payload.get("unit", UNIT)),
            acknowledged=acknowledged,
        )


@dataclass(frozen=True)
class SourceStatus:
    """How current one upstream's data is.

    ``ok`` compares this source's worst zone against the lag that is normal for
    that upstream — Europe publishes within hours, EIA can be most of a day
    behind on its own schedule. A single global threshold would either cry wolf
    on the US feed or stay silent through a European outage.
    """

    source: str
    zones: int
    freshest_lag_hours: float
    stalest_lag_hours: float
    stale_after_hours: float
    ok: bool


@dataclass(frozen=True)
class IngestionStatus:
    """Whether collection is keeping up, per source.

    Distinct from :meth:`GridCarbon.health`, which only says the API is
    reachable. A reachable API serving day-old numbers is the failure worth
    catching, and it is invisible to a liveness check.
    """

    ok: bool
    ts: datetime
    note: str
    sources: List[SourceStatus]

    def stale_sources(self) -> List[SourceStatus]:
        """The sources that are behind, if any."""
        return [s for s in self.sources if not s.ok]

