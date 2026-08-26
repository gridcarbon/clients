"""Minimal JSON-over-HTTP helper built on ``urllib.request``.

Deliberately dependency-free. Tests replace the module-level :func:`urlopen`
name, so no network access is needed to exercise the client.
"""

from __future__ import annotations

import json
import socket
from typing import Any, Dict, Optional, Sequence, Tuple
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen  # noqa: F401  (patched in tests)

from .errors import ApiError, GridCarbonTimeout, NetworkError

__all__ = ["build_url", "get_json"]

_MAX_BYTES = 32 * 1024 * 1024  # refuse to buffer an absurd response


def build_url(base_url: str, path: str, params: Optional[Sequence[Tuple[str, str]]] = None) -> str:
    """Join ``base_url`` and ``path`` and append a query string."""
    url = base_url.rstrip("/") + "/" + path.lstrip("/")
    if params:
        url += "?" + urlencode(list(params))
    return url


def _decode(raw: bytes) -> Optional[Any]:
    if not raw:
        return None
    try:
        return json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None


def _error_from_body(status: int, raw: bytes, url: str, reason: str) -> ApiError:
    """Turn an error response into an :class:`ApiError`.

    The API documents ``{"error": "..."}`` bodies and sometimes adds a ``hint``.
    Anything else (an HTML edge error page, an empty body) degrades gracefully.
    """
    payload = _decode(raw)
    message = ""
    if isinstance(payload, dict):
        raw_message = payload.get("error")
        if isinstance(raw_message, str) and raw_message:
            message = raw_message
        hint = payload.get("hint")
        if message and isinstance(hint, str) and hint:
            message = "{0} ({1})".format(message, hint)
    if not message:
        text = raw.decode("utf-8", "replace").strip()
        message = text[:200] if text else (reason or "no error message")
    return ApiError(
        status,
        message,
        payload=payload if isinstance(payload, dict) else None,
        url=url,
    )


def get_json(url: str, *, timeout: float, user_agent: str) -> Dict[str, Any]:
    """GET ``url`` and return the decoded JSON object.

    Raises:
        ApiError: Non-2xx response, or a 2xx body that is not a JSON object.
        GridCarbonTimeout: The request exceeded ``timeout``.
        NetworkError: The request never reached an HTTP response.
    """
    request = Request(
        url,
        method="GET",
        headers={
            "User-Agent": user_agent,
            "Accept": "application/json",
        },
    )

    try:
        with urlopen(request, timeout=timeout) as response:
            raw = response.read(_MAX_BYTES)
            status = getattr(response, "status", None)
            if status is None:  # pragma: no cover - very old urllib objects
                status = response.getcode()
    except HTTPError as exc:
        # HTTPError is itself a response object; read the documented body.
        try:
            body = exc.read()
        except Exception:  # pragma: no cover - body already consumed
            body = b""
        raise _error_from_body(exc.code, body, url, str(getattr(exc, "reason", ""))) from exc
    except socket.timeout as exc:
        raise GridCarbonTimeout(
            "request to {0} timed out after {1}s".format(url, timeout), url=url
        ) from exc
    except URLError as exc:
        reason = exc.reason
        if isinstance(reason, socket.timeout) or isinstance(reason, TimeoutError):
            raise GridCarbonTimeout(
                "request to {0} timed out after {1}s".format(url, timeout), url=url
            ) from exc
        raise NetworkError(
            "could not reach {0}: {1}".format(url, reason), url=url
        ) from exc
    except (OSError, ValueError) as exc:
        # ValueError covers a malformed base_url reaching urlopen.
        raise NetworkError("could not reach {0}: {1}".format(url, exc), url=url) from exc

    if not (200 <= int(status) < 300):  # pragma: no cover - urllib raises first
        raise _error_from_body(int(status), raw, url, "")

    payload = _decode(raw)
    if not isinstance(payload, dict):
        preview = raw.decode("utf-8", "replace")[:200]
        raise ApiError(
            int(status),
            "expected a JSON object from {0}, got: {1!r}".format(url, preview),
            url=url,
        )
    return payload
