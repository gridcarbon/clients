"""Synchronous client for the gridcarbon.dev API."""

from __future__ import annotations

from typing import Sequence, Any, Dict, List, Optional, Tuple, Union, overload

from . import _http
from ._time import TimeLike, format_iso, parse_iso
from .errors import ApiError, UnknownZone
from .models import IngestionStatus, Reading, Series, SourceStatus, Zone

__all__ = [
    "GridCarbon",
    "DEFAULT_BASE_URL",
    "DEFAULT_TIMEOUT",
    "DEFAULT_USER_AGENT",
    "__version__",
]

__version__ = "0.1.1"

DEFAULT_BASE_URL = "https://api.gridcarbon.dev"
DEFAULT_TIMEOUT = 10.0
DEFAULT_USER_AGENT = "gridcarbon-python/{0}".format(__version__)


class GridCarbon:
    """Client for the gridcarbon.dev carbon-intensity API.

    Args:
        base_url: API root. Override to point at a staging deployment.
        timeout: Per-request socket timeout in seconds.
        user_agent: Sent on every request. Please keep the default token and
            append your own, e.g. ``"gridcarbon-python/0.1.0 myapp/2.1"``, so
            the API operator can tell clients apart.

    Example::

        gc = GridCarbon()
        de = gc.latest("DE")
        print(de.gco2eq_kwh, de.ts, de.age)

    The client is stateless and holds no connection, so instances are cheap and
    safe to share between threads.

    .. note::
       ``latest`` is edge-cached with a 5 minute TTL. Polling faster than that
       gets you the same bytes; please don't.
    """

    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = DEFAULT_TIMEOUT,
        user_agent: str = DEFAULT_USER_AGENT,
    ) -> None:
        if not base_url:
            raise ValueError("base_url must not be empty")
        if timeout <= 0:
            raise ValueError("timeout must be positive, got {0!r}".format(timeout))
        if not user_agent:
            raise ValueError("user_agent must not be empty")
        self.base_url = base_url.rstrip("/")
        self.timeout = float(timeout)
        self.user_agent = user_agent

    # -- internals ---------------------------------------------------------

    def _get(
        self,
        path: str,
        params: Optional[List[Tuple[str, str]]] = None,
        *,
        accept: Sequence[int] = (),
    ) -> Dict[str, Any]:
        url = _http.build_url(self.base_url, path, params)
        return _http.get_json(
            url, timeout=self.timeout, user_agent=self.user_agent, accept=accept
        )

    @staticmethod
    def _clean_zone(zone: str) -> str:
        """Validate and normalise a zone id.

        Guards a real API footgun: ``?zone=`` (empty) is answered with *all*
        zones rather than an error, so an empty string must never reach the
        wire.
        """
        if not isinstance(zone, str):
            raise TypeError("zone must be a string, got {0!r}".format(type(zone).__name__))
        cleaned = zone.strip().upper()
        if not cleaned:
            raise ValueError("zone must not be empty")
        return cleaned

    # -- endpoints ---------------------------------------------------------

    def health(self) -> bool:
        """Return ``True`` if the API reports itself healthy."""
        return bool(self._get("/v1/health").get("ok", False))

    def status(self) -> IngestionStatus:
        """Report whether ingestion is current, per upstream source.

        ``health()`` only tells you the API answered. This tells you whether the
        numbers it would answer with are fresh, which is the question that
        actually matters before you act on a value.
        """
        # 503 here is not a failure: the API answers 503 whenever a source is
        # behind, and the body is the full report. Treat it as data.
        d = self._get("/v1/status", accept=(503,))
        return IngestionStatus(
            ok=bool(d.get("ok", False)),
            ts=parse_iso(d["ts"]),
            note=str(d.get("note", "")),
            sources=[
                SourceStatus(
                    source=str(s["source"]),
                    zones=int(s["zones"]),
                    freshest_lag_hours=float(s["freshest_lag_hours"]),
                    stalest_lag_hours=float(s["stalest_lag_hours"]),
                    stale_after_hours=float(s["stale_after_hours"]),
                    ok=bool(s["ok"]),
                )
                for s in d.get("sources", [])
            ],
        )

    def zones(self) -> List[Zone]:
        """List every zone the API publishes, ordered as the API returns them.

        Returns:
            A list of :class:`~gridcarbon.Zone`. Empty if the API has none.
        """
        payload = self._get("/v1/zones")
        return [Zone.from_json(item) for item in (payload.get("data") or [])]

    @overload
    def latest(self) -> List[Reading]: ...

    @overload
    def latest(self, zone: str) -> Reading: ...

    def latest(self, zone: Optional[str] = None) -> Union[Reading, List[Reading]]:
        """Fetch the most recently published reading.

        Args:
            zone: A zone id such as ``"DE"``. Case-insensitive. Omit it to get
                one reading for every zone.

        Returns:
            A single :class:`~gridcarbon.Reading` when ``zone`` is given,
            otherwise a list of readings -- one per zone.

        Raises:
            UnknownZone: ``zone`` is not a zone the API knows.
            ApiError: Any other non-2xx response.
            GridCarbonTimeout: The request timed out.
            NetworkError: The API was unreachable.
            ValueError: ``zone`` was given but blank.

        .. warning::
           "Latest" means *most recently published*, not *now*. Check
           :attr:`Reading.age` before treating a value as current.
        """
        if zone is None:
            payload = self._get("/v1/intensity/latest")
            return [Reading.from_json(item) for item in (payload.get("data") or [])]

        cleaned = self._clean_zone(zone)
        try:
            payload = self._get("/v1/intensity/latest", [("zone", cleaned)])
        except ApiError as exc:
            if exc.status == 404:
                raise UnknownZone(
                    cleaned, exc.status, exc.message, payload=exc.payload, url=exc.url
                ) from exc
            raise

        items = payload.get("data") or []
        if not items:
            # Defensive: the API 404s on unknown zones today, but an empty
            # 200 must not surface as an IndexError.
            raise UnknownZone(cleaned, 200, "no data returned for zone: {0}".format(cleaned))
        return Reading.from_json(items[0])

    def series(
        self,
        zone: str,
        start: Optional[TimeLike] = None,
        end: Optional[TimeLike] = None,
        *,
        allow_truncated: bool = False,
    ) -> Series:
        """Fetch a time series of readings for one zone.

        Args:
            zone: Zone id, case-insensitive.
            start: Window start, inclusive. A :class:`~datetime.datetime` or an
                ISO-8601 string. Naive datetimes are read as UTC; aware ones
                are converted. Defaults to 24 hours before ``end``.
            end: Window end, **exclusive**. Same accepted types.
            allow_truncated: Pass ``True`` to pre-acknowledge a capped result
                and skip the :class:`~gridcarbon.TruncatedSeriesError` gate.

        Returns:
            A :class:`~gridcarbon.Series`. Check :attr:`Series.truncated`.

        Raises:
            ApiError: Non-2xx response.
            GridCarbonTimeout: The request timed out.
            NetworkError: The API was unreachable.
            ValueError: ``zone`` was blank, or a timestamp was unparseable.

        .. note::
           Unlike :meth:`latest`, this does **not** raise
           :class:`~gridcarbon.UnknownZone` for a bad zone id: the endpoint
           answers unknown zones with ``200`` and an empty ``data`` array, so it
           is indistinguishable from an empty window. Validate against
           :meth:`zones` if that matters.

           The SDK parses ``start``/``end`` locally and raises on malformed
           input. The API itself silently ignores an unparseable ``from`` and
           substitutes its default, which would hand you the wrong window.
        """
        cleaned = self._clean_zone(zone)
        params: List[Tuple[str, str]] = [("zone", cleaned)]
        if start is not None:
            params.append(("from", format_iso(start)))
        if end is not None:
            params.append(("to", format_iso(end)))

        payload = self._get("/v1/intensity", params)
        return Series.from_json(payload, acknowledged=allow_truncated)
