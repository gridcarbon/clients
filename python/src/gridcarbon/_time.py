"""ISO-8601 helpers.

Kept separate because Python 3.9's ``datetime.fromisoformat`` cannot parse a
trailing ``Z`` and only accepts 3- or 6-digit fractional seconds, while the API
emits both ``2026-08-26T01:00:00Z`` and ``2026-08-26T02:46:21.901Z``.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Union

__all__ = ["parse_iso", "to_utc", "format_iso"]

_FRACTION = re.compile(r"\.(\d+)")

TimeLike = Union[datetime, str]


def parse_iso(value: str) -> datetime:
    """Parse an ISO-8601 timestamp into a timezone-aware UTC datetime.

    Accepts a trailing ``Z``, any number of fractional-second digits, and an
    explicit offset. A timestamp with no offset at all is read as UTC, which is
    what the API documents its bare timestamps to mean.

    Raises:
        ValueError: If the string is not a parseable ISO-8601 timestamp.
    """
    if not isinstance(value, str):
        raise TypeError("expected an ISO-8601 string, got {0!r}".format(type(value).__name__))

    text = value.strip()
    if not text:
        raise ValueError("empty timestamp string")

    if text.endswith(("Z", "z")):
        text = text[:-1] + "+00:00"

    # Normalise fractional seconds to exactly 6 digits for 3.9's parser.
    def _pad(match: "re.Match[str]") -> str:
        digits = match.group(1)[:6]
        return "." + digits.ljust(6, "0")

    text = _FRACTION.sub(_pad, text, count=1)

    try:
        parsed = datetime.fromisoformat(text)
    except ValueError as exc:
        raise ValueError("not a valid ISO-8601 timestamp: {0!r}".format(value)) from exc

    return to_utc(parsed)


def to_utc(value: datetime) -> datetime:
    """Return ``value`` as a timezone-aware UTC datetime.

    A naive datetime is assumed to already be UTC rather than local time. This
    is deliberate: the API is UTC-only, and silently applying the machine's
    local offset is a classic source of off-by-hours bugs.
    """
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def format_iso(value: TimeLike) -> str:
    """Coerce a datetime or ISO string to a UTC ``...Z`` string for the wire."""
    if isinstance(value, datetime):
        moment = to_utc(value)
    elif isinstance(value, str):
        moment = parse_iso(value)
    else:
        raise TypeError(
            "expected a datetime or an ISO-8601 string, got {0!r}".format(
                type(value).__name__
            )
        )
    return moment.replace(tzinfo=None).isoformat(timespec="seconds") + "Z"
