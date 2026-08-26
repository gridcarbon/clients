"""Exception hierarchy for the gridcarbon SDK.

All errors raised by this package derive from :class:`GridCarbonError`, so a
single ``except GridCarbonError`` will catch everything the SDK throws.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

__all__ = [
    "GridCarbonError",
    "ApiError",
    "UnknownZone",
    "NetworkError",
    "GridCarbonTimeout",
    "TruncatedSeriesError",
]


class GridCarbonError(Exception):
    """Base class for every error raised by this SDK."""


class ApiError(GridCarbonError):
    """The API returned a non-2xx response.

    Attributes:
        status: HTTP status code.
        message: The ``error`` string from the response body, when the server
            sent a JSON body of the documented ``{"error": "..."}`` shape.
            Falls back to the raw body text, then to the HTTP reason phrase.
        payload: The decoded JSON body, if it was decodable. The API may
            include extra keys such as ``hint``.
        url: The URL that produced the error.
    """

    def __init__(
        self,
        status: int,
        message: str,
        *,
        payload: Optional[Dict[str, Any]] = None,
        url: Optional[str] = None,
    ) -> None:
        super().__init__("HTTP {0}: {1}".format(status, message))
        self.status = status
        self.message = message
        self.payload = payload
        self.url = url


class UnknownZone(ApiError):
    """The requested zone id is not one the API knows about.

    Raised by :meth:`GridCarbon.latest` when called with a single zone that the
    API rejects with a 404.

    .. note::
       ``GridCarbon.series()`` does **not** raise this. The upstream
       ``/v1/intensity`` endpoint answers an unknown zone with ``200`` and an
       empty ``data`` array, so an unknown zone is indistinguishable from a
       window with no data. Validate against :meth:`GridCarbon.zones` if you
       need certainty.
    """

    def __init__(
        self,
        zone: str,
        status: int = 404,
        message: str = "",
        *,
        payload: Optional[Dict[str, Any]] = None,
        url: Optional[str] = None,
    ) -> None:
        super().__init__(
            status,
            message or "unknown or empty zone: {0}".format(zone),
            payload=payload,
            url=url,
        )
        self.zone = zone


class NetworkError(GridCarbonError):
    """The request never produced an HTTP response (DNS, TLS, refused, ...)."""

    def __init__(self, message: str, *, url: Optional[str] = None) -> None:
        super().__init__(message)
        self.url = url


class GridCarbonTimeout(NetworkError, TimeoutError):
    """The request exceeded the client timeout.

    Subclasses the builtin :class:`TimeoutError` as well, so existing
    ``except TimeoutError`` handlers keep working.
    """


class TruncatedSeriesError(GridCarbonError):
    """Raised when a caller reads a truncated :class:`Series` without saying so.

    The API caps a series at 5000 points. Iterating a capped result as though it
    were the whole window silently under-counts emissions, so the SDK refuses to
    hand over the readings until you acknowledge the cap -- either by passing
    ``allow_truncated=True`` to :meth:`GridCarbon.series` or by calling
    :meth:`Series.acknowledge_truncation`.
    """

    def __init__(self, series: "Any") -> None:
        super().__init__(
            "Series for zone {0!r} is TRUNCATED: the API returned {1} points "
            "and capped the result, so this is NOT the full window "
            "[{2} .. {3}). Iterating it would silently under-report.\n"
            "Either narrow the window with start=/end=, or acknowledge the cap "
            "explicitly:\n"
            "    gc.series({0!r}, ..., allow_truncated=True)\n"
            "    # or: series.acknowledge_truncation()\n"
            "Server note: {4}".format(
                series.zone,
                series.count,
                series.start.isoformat(),
                series.end.isoformat(),
                series.note or "(none)",
            )
        )
        self.series = series
