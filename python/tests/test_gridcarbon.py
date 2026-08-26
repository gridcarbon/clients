"""Offline unit tests for the gridcarbon SDK.

No network access: :func:`gridcarbon._http.urlopen` is replaced with a fake for
every test. The payloads below are verbatim copies of real responses captured
from https://api.gridcarbon.dev on 2026-08-26.

Run with:  python -m unittest discover -s tests -v
"""

from __future__ import annotations

import io
import json
import socket
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock
from urllib.error import HTTPError, URLError

from gridcarbon import (
    ApiError,
    GridCarbon,
    GridCarbonError,
    GridCarbonTimeout,
    NetworkError,
    Reading,
    Series,
    TruncatedSeriesError,
    UnknownZone,
    Zone,
    __version__,
)
from gridcarbon._time import format_iso, parse_iso

# --------------------------------------------------------------------------
# Real captured payloads
# --------------------------------------------------------------------------

ZONES_BODY = {
    "data": [
        {"zone": "AT", "name": "Austria", "source": "entsoe", "resolution_min": 60},
        {"zone": "DE", "name": "Germany-Luxembourg", "source": "entsoe", "resolution_min": 60},
        {"zone": "GB", "name": "Great Britain", "source": "uk-neso", "resolution_min": 30},
        {"zone": "US-CAISO", "name": "California ISO", "source": "eia", "resolution_min": 60},
    ]
}

LATEST_DE_BODY = {
    "unit": "gCO2eq/kWh",
    "data": [
        {"zone": "DE", "ts": "2026-08-26T01:00:00Z", "gco2eq_kwh": 371.4, "method": "computed:v1"}
    ],
}

# Note gco2eq_kwh is a bare integer here, exactly as the API sent it.
LATEST_GB_BODY = {
    "unit": "gCO2eq/kWh",
    "data": [
        {
            "zone": "GB",
            "ts": "2026-08-26T01:30:00Z",
            "gco2eq_kwh": 114,
            "method": "upstream:uk-neso:forecast",
        }
    ],
}

LATEST_ALL_BODY = {
    "unit": "gCO2eq/kWh",
    "data": [
        {"zone": "AT", "ts": "2026-08-26T01:00:00Z", "gco2eq_kwh": 54.9, "method": "computed:v1"},
        {"zone": "DE", "ts": "2026-08-26T01:00:00Z", "gco2eq_kwh": 371.4, "method": "computed:v1"},
        {
            "zone": "GB",
            "ts": "2026-08-26T01:30:00Z",
            "gco2eq_kwh": 114,
            "method": "upstream:uk-neso:forecast",
        },
        {"zone": "US-PJM", "ts": "2026-08-25T02:00:00Z", "gco2eq_kwh": 382.1, "method": "computed:v1"},
    ],
}

SERIES_DE_BODY = {
    "zone": "DE",
    "from": "2026-08-25T02:46:21.901Z",
    "to": "2026-08-26T02:46:21.901Z",
    "unit": "gCO2eq/kWh",
    "count": 3,
    "truncated": False,
    "data": [
        {"ts": "2026-08-25T03:00:00Z", "gco2eq_kwh": 366.4, "method": "computed:v1"},
        {"ts": "2026-08-25T07:00:00Z", "gco2eq_kwh": 282, "method": "computed:v1"},
        {"ts": "2026-08-26T01:00:00Z", "gco2eq_kwh": 371.4, "method": "computed:v1"},
    ],
}

SERIES_EMPTY_BODY = {
    "zone": "ZZ",
    "from": "2026-08-25T02:46:40.423Z",
    "to": "2026-08-26T02:46:40.423Z",
    "unit": "gCO2eq/kWh",
    "count": 0,
    "truncated": False,
    "data": [],
}

SERIES_TRUNCATED_BODY = {
    "zone": "DE",
    "from": "2026-08-21T00:00:00Z",
    "to": "2026-08-26T00:00:00Z",
    "unit": "gCO2eq/kWh",
    "count": 5000,
    "truncated": True,
    "note": "Result capped at 5000 points. Narrow the window with 'from'/'to' to get the rest.",
    "data": [
        {"ts": "2026-08-21T00:00:00Z", "gco2eq_kwh": 400.0, "method": "computed:v1"},
        {"ts": "2026-08-21T01:00:00Z", "gco2eq_kwh": 410.0, "method": "computed:v1"},
    ],
}

UNKNOWN_ZONE_BODY = {"error": "unknown or empty zone: ZZ"}
NOT_FOUND_BODY = {"error": "not found", "hint": "see GET /v1 for available endpoints"}


# --------------------------------------------------------------------------
# Fake transport
# --------------------------------------------------------------------------


class FakeResponse(io.BytesIO):
    """Stands in for the object ``urlopen`` returns."""

    def __init__(self, body: bytes, status: int = 200) -> None:
        super().__init__(body)
        self.status = status

    def getcode(self) -> int:
        return self.status

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()


class FakeTransport:
    """Records requests and replays canned responses."""

    def __init__(self, *responses: object) -> None:
        self.responses = list(responses)
        self.requests = []

    def __call__(self, request, timeout=None):  # noqa: ANN001
        self.requests.append((request, timeout))
        if not self.responses:
            raise AssertionError("no canned response left for {0}".format(request.full_url))
        item = self.responses.pop(0)
        if isinstance(item, Exception):
            raise item
        return FakeResponse(json.dumps(item).encode("utf-8"))

    # -- assertions helpers ----
    @property
    def last_url(self) -> str:
        return self.requests[-1][0].full_url

    @property
    def last_headers(self):  # noqa: ANN201
        return self.requests[-1][0].headers

    @property
    def last_timeout(self):  # noqa: ANN201
        return self.requests[-1][1]


def http_error(status: int, body: object, url: str = "https://api.gridcarbon.dev/x") -> HTTPError:
    raw = json.dumps(body).encode("utf-8") if not isinstance(body, bytes) else body
    return HTTPError(url, status, "err", {}, io.BytesIO(raw))


class ClientTestCase(unittest.TestCase):
    """Base class that patches the transport for every test."""

    def make(self, *responses: object, **kwargs: object) -> "tuple[GridCarbon, FakeTransport]":
        transport = FakeTransport(*responses)
        patcher = mock.patch("gridcarbon._http.urlopen", transport)
        patcher.start()
        self.addCleanup(patcher.stop)
        return GridCarbon(**kwargs), transport  # type: ignore[arg-type]


# --------------------------------------------------------------------------
# Time helpers
# --------------------------------------------------------------------------


class TestTimeHelpers(unittest.TestCase):
    def test_parses_z_suffix(self) -> None:
        self.assertEqual(
            parse_iso("2026-08-26T01:00:00Z"),
            datetime(2026, 8, 26, 1, 0, tzinfo=timezone.utc),
        )

    def test_parses_milliseconds(self) -> None:
        self.assertEqual(
            parse_iso("2026-08-26T02:46:21.901Z"),
            datetime(2026, 8, 26, 2, 46, 21, 901000, tzinfo=timezone.utc),
        )

    def test_parses_explicit_offset_into_utc(self) -> None:
        self.assertEqual(
            parse_iso("2026-08-26T03:00:00+02:00"),
            datetime(2026, 8, 26, 1, 0, tzinfo=timezone.utc),
        )

    def test_naive_string_is_read_as_utc(self) -> None:
        self.assertEqual(
            parse_iso("2026-08-26T01:00:00"),
            datetime(2026, 8, 26, 1, 0, tzinfo=timezone.utc),
        )

    def test_rejects_garbage(self) -> None:
        with self.assertRaises(ValueError):
            parse_iso("nonsense")

    def test_format_converts_aware_datetime_to_utc(self) -> None:
        aware = datetime(2026, 8, 26, 3, 0, tzinfo=timezone(timedelta(hours=2)))
        self.assertEqual(format_iso(aware), "2026-08-26T01:00:00Z")

    def test_format_treats_naive_datetime_as_utc(self) -> None:
        self.assertEqual(format_iso(datetime(2026, 8, 26, 1, 0)), "2026-08-26T01:00:00Z")

    def test_format_rejects_wrong_type(self) -> None:
        with self.assertRaises(TypeError):
            format_iso(1756170000)  # type: ignore[arg-type]


# --------------------------------------------------------------------------
# Models
# --------------------------------------------------------------------------


class TestReading(unittest.TestCase):
    def test_coerces_integer_intensity_to_float(self) -> None:
        reading = Reading.from_json(LATEST_GB_BODY["data"][0])
        self.assertIsInstance(reading.gco2eq_kwh, float)
        self.assertEqual(reading.gco2eq_kwh, 114.0)

    def test_series_item_inherits_zone_from_envelope(self) -> None:
        reading = Reading.from_json(SERIES_DE_BODY["data"][0], zone="DE")
        self.assertEqual(reading.zone, "DE")

    def test_missing_zone_raises(self) -> None:
        with self.assertRaises(ValueError):
            Reading.from_json({"ts": "2026-08-26T01:00:00Z", "gco2eq_kwh": 1, "method": "x"})

    def test_is_lifecycle_true_for_computed(self) -> None:
        self.assertTrue(Reading.from_json(LATEST_DE_BODY["data"][0]).is_lifecycle)

    def test_is_lifecycle_false_for_neso_forecast_and_actual(self) -> None:
        for method in ("upstream:uk-neso:forecast", "upstream:uk-neso:actual"):
            reading = Reading("GB", datetime.now(timezone.utc), 114.0, method)
            self.assertFalse(reading.is_lifecycle, method)

    def test_is_forecast(self) -> None:
        self.assertTrue(Reading.from_json(LATEST_GB_BODY["data"][0]).is_forecast)
        self.assertFalse(Reading.from_json(LATEST_DE_BODY["data"][0]).is_forecast)

    def test_age_is_positive_timedelta(self) -> None:
        reading = Reading("DE", datetime.now(timezone.utc) - timedelta(hours=3), 100.0, "computed:v1")
        self.assertIsInstance(reading.age, timedelta)
        self.assertAlmostEqual(reading.age.total_seconds(), 3 * 3600, delta=5)

    def test_ts_is_timezone_aware(self) -> None:
        self.assertIsNotNone(Reading.from_json(LATEST_DE_BODY["data"][0]).ts.tzinfo)

    def test_is_frozen(self) -> None:
        reading = Reading.from_json(LATEST_DE_BODY["data"][0])
        with self.assertRaises(Exception):
            reading.gco2eq_kwh = 5.0  # type: ignore[misc]


class TestZone(unittest.TestCase):
    def test_from_json(self) -> None:
        zone = Zone.from_json(ZONES_BODY["data"][2])
        self.assertEqual((zone.zone, zone.name, zone.source, zone.resolution_min),
                         ("GB", "Great Britain", "uk-neso", 30))

    def test_gb_is_not_lifecycle(self) -> None:
        self.assertFalse(Zone.from_json(ZONES_BODY["data"][2]).is_lifecycle)
        self.assertTrue(Zone.from_json(ZONES_BODY["data"][1]).is_lifecycle)


class TestSeriesTruncationGate(unittest.TestCase):
    def build(self, **kwargs: object) -> Series:
        return Series.from_json(SERIES_TRUNCATED_BODY, **kwargs)  # type: ignore[arg-type]

    def test_iterating_truncated_raises(self) -> None:
        with self.assertRaises(TruncatedSeriesError):
            list(self.build())

    def test_indexing_truncated_raises(self) -> None:
        with self.assertRaises(TruncatedSeriesError):
            self.build()[0]

    def test_slicing_truncated_raises(self) -> None:
        with self.assertRaises(TruncatedSeriesError):
            self.build()[0:1]

    def test_readings_property_truncated_raises(self) -> None:
        with self.assertRaises(TruncatedSeriesError):
            self.build().readings

    def test_average_truncated_raises(self) -> None:
        with self.assertRaises(TruncatedSeriesError):
            self.build().average()

    def test_error_is_a_gridcarbon_error(self) -> None:
        self.assertTrue(issubclass(TruncatedSeriesError, GridCarbonError))

    def test_error_message_names_the_escape_hatches(self) -> None:
        try:
            list(self.build())
        except TruncatedSeriesError as exc:
            text = str(exc)
            self.assertIn("allow_truncated=True", text)
            self.assertIn("acknowledge_truncation", text)
            self.assertIn("Result capped at 5000 points", text)
        else:  # pragma: no cover
            self.fail("expected TruncatedSeriesError")

    def test_diagnostics_remain_readable_without_acknowledging(self) -> None:
        series = self.build()
        self.assertTrue(series.truncated)
        self.assertEqual(series.count, 5000)
        self.assertEqual(len(series), 2)
        self.assertTrue(bool(series))
        self.assertIn("TRUNCATED", repr(series))
        self.assertIn("capped", series.note or "")

    def test_acknowledge_unlocks_and_returns_self(self) -> None:
        series = self.build()
        same = series.acknowledge_truncation()
        self.assertIs(same, series)
        self.assertEqual(len(list(series)), 2)

    def test_constructor_flag_unlocks(self) -> None:
        self.assertEqual(len(list(self.build(acknowledged=True))), 2)

    def test_untruncated_series_needs_no_acknowledgement(self) -> None:
        series = Series.from_json(SERIES_DE_BODY)
        self.assertFalse(series.truncated)
        self.assertIsNone(series.note)
        self.assertEqual(len(list(series)), 3)


class TestSeriesShape(unittest.TestCase):
    def setUp(self) -> None:
        self.series = Series.from_json(SERIES_DE_BODY)

    def test_every_reading_has_zone_populated(self) -> None:
        self.assertTrue(all(r.zone == "DE" for r in self.series))

    def test_count_and_len_agree(self) -> None:
        self.assertEqual(self.series.count, len(self.series))

    def test_window_parsed_as_aware_utc(self) -> None:
        self.assertEqual(self.series.start.tzinfo, timezone.utc)
        self.assertEqual(self.series.end.tzinfo, timezone.utc)

    def test_indexing_and_slicing(self) -> None:
        self.assertEqual(self.series[0].gco2eq_kwh, 366.4)
        self.assertEqual(self.series[-1].gco2eq_kwh, 371.4)
        self.assertEqual(len(self.series[:2]), 2)

    def test_average(self) -> None:
        self.assertAlmostEqual(self.series.average(), (366.4 + 282 + 371.4) / 3, places=6)

    def test_empty_series_is_falsy_and_averages_none(self) -> None:
        empty = Series.from_json(SERIES_EMPTY_BODY)
        self.assertEqual(len(empty), 0)
        self.assertFalse(empty)
        self.assertIsNone(empty.average())
        self.assertEqual(list(empty), [])


# --------------------------------------------------------------------------
# Client: requests
# --------------------------------------------------------------------------


class TestRequestConstruction(ClientTestCase):
    def test_sets_descriptive_user_agent(self) -> None:
        client, transport = self.make(LATEST_DE_BODY)
        client.latest("DE")
        # urllib normalises header names to title case.
        self.assertEqual(transport.last_headers["User-agent"], "gridcarbon-python/" + __version__)

    def test_accept_header_is_json(self) -> None:
        client, transport = self.make(LATEST_DE_BODY)
        client.latest("DE")
        self.assertEqual(transport.last_headers["Accept"], "application/json")

    def test_custom_user_agent(self) -> None:
        client, transport = self.make(LATEST_DE_BODY, user_agent="gridcarbon-python/0.1.0 myapp/2")
        client.latest("DE")
        self.assertEqual(transport.last_headers["User-agent"], "gridcarbon-python/0.1.0 myapp/2")

    def test_timeout_is_passed_through(self) -> None:
        client, transport = self.make(LATEST_DE_BODY, timeout=3.5)
        client.latest("DE")
        self.assertEqual(transport.last_timeout, 3.5)

    def test_custom_base_url_and_trailing_slash(self) -> None:
        client, transport = self.make(ZONES_BODY, base_url="https://staging.example.com/")
        client.zones()
        self.assertEqual(transport.last_url, "https://staging.example.com/v1/zones")

    def test_rejects_bad_constructor_args(self) -> None:
        for kwargs in ({"base_url": ""}, {"timeout": 0}, {"timeout": -1}, {"user_agent": ""}):
            with self.assertRaises(ValueError):
                GridCarbon(**kwargs)  # type: ignore[arg-type]


class TestZonesEndpoint(ClientTestCase):
    def test_returns_typed_zones(self) -> None:
        client, transport = self.make(ZONES_BODY)
        zones = client.zones()
        self.assertEqual(transport.last_url, "https://api.gridcarbon.dev/v1/zones")
        self.assertEqual(len(zones), 4)
        self.assertIsInstance(zones[0], Zone)
        self.assertEqual([z.zone for z in zones], ["AT", "DE", "GB", "US-CAISO"])

    def test_handles_empty_data(self) -> None:
        client, _ = self.make({"data": []})
        self.assertEqual(client.zones(), [])

    def test_handles_missing_data_key(self) -> None:
        client, _ = self.make({})
        self.assertEqual(client.zones(), [])


class TestLatestEndpoint(ClientTestCase):
    def test_single_zone_returns_one_reading(self) -> None:
        client, transport = self.make(LATEST_DE_BODY)
        reading = client.latest("DE")
        self.assertIsInstance(reading, Reading)
        self.assertEqual(reading.zone, "DE")
        self.assertEqual(reading.gco2eq_kwh, 371.4)
        self.assertEqual(transport.last_url, "https://api.gridcarbon.dev/v1/intensity/latest?zone=DE")

    def test_no_zone_returns_list(self) -> None:
        client, transport = self.make(LATEST_ALL_BODY)
        readings = client.latest()
        self.assertIsInstance(readings, list)
        self.assertEqual(len(readings), 4)
        self.assertEqual(transport.last_url, "https://api.gridcarbon.dev/v1/intensity/latest")

    def test_zone_is_uppercased(self) -> None:
        client, transport = self.make(LATEST_DE_BODY)
        client.latest("de")
        self.assertIn("zone=DE", transport.last_url)

    def test_zone_is_stripped(self) -> None:
        client, transport = self.make(LATEST_DE_BODY)
        client.latest("  de  ")
        self.assertIn("zone=DE", transport.last_url)

    def test_hyphenated_zone_is_url_encoded_correctly(self) -> None:
        client, transport = self.make(LATEST_ALL_BODY)
        client.latest("US-CAISO")
        self.assertIn("zone=US-CAISO", transport.last_url)

    def test_blank_zone_never_reaches_the_wire(self) -> None:
        # Guards a real API behaviour: '?zone=' returns ALL zones, so a blank
        # zone must fail loudly rather than silently return the wrong thing.
        client, transport = self.make(LATEST_ALL_BODY)
        for blank in ("", "   "):
            with self.assertRaises(ValueError):
                client.latest(blank)
        self.assertEqual(transport.requests, [])

    def test_non_string_zone_raises_type_error(self) -> None:
        client, _ = self.make(LATEST_DE_BODY)
        with self.assertRaises(TypeError):
            client.latest(42)  # type: ignore[arg-type]

    def test_unknown_zone_raises_unknown_zone(self) -> None:
        client, _ = self.make(http_error(404, UNKNOWN_ZONE_BODY))
        with self.assertRaises(UnknownZone) as ctx:
            client.latest("ZZ")
        self.assertEqual(ctx.exception.zone, "ZZ")
        self.assertEqual(ctx.exception.status, 404)
        self.assertEqual(ctx.exception.message, "unknown or empty zone: ZZ")

    def test_unknown_zone_is_catchable_as_api_error(self) -> None:
        client, _ = self.make(http_error(404, UNKNOWN_ZONE_BODY))
        with self.assertRaises(ApiError):
            client.latest("ZZ")

    def test_empty_data_for_single_zone_raises_unknown_zone(self) -> None:
        client, _ = self.make({"unit": "gCO2eq/kWh", "data": []})
        with self.assertRaises(UnknownZone):
            client.latest("ZZ")

    def test_empty_data_for_all_zones_returns_empty_list(self) -> None:
        client, _ = self.make({"unit": "gCO2eq/kWh", "data": []})
        self.assertEqual(client.latest(), [])

    def test_gb_reading_flagged_not_lifecycle(self) -> None:
        client, _ = self.make(LATEST_GB_BODY)
        self.assertFalse(client.latest("GB").is_lifecycle)


class TestSeriesEndpoint(ClientTestCase):
    def test_default_window_sends_only_zone(self) -> None:
        client, transport = self.make(SERIES_DE_BODY)
        series = client.series("DE")
        self.assertEqual(transport.last_url, "https://api.gridcarbon.dev/v1/intensity?zone=DE")
        self.assertEqual(series.count, 3)

    def test_accepts_datetime_bounds(self) -> None:
        client, transport = self.make(SERIES_DE_BODY)
        client.series(
            "DE",
            start=datetime(2026, 8, 25, 0, 0, tzinfo=timezone.utc),
            end=datetime(2026, 8, 26, 0, 0, tzinfo=timezone.utc),
        )
        self.assertIn("from=2026-08-25T00%3A00%3A00Z", transport.last_url)
        self.assertIn("to=2026-08-26T00%3A00%3A00Z", transport.last_url)

    def test_accepts_iso_string_bounds(self) -> None:
        client, transport = self.make(SERIES_DE_BODY)
        client.series("DE", start="2026-08-25T00:00:00Z", end="2026-08-26T00:00:00Z")
        self.assertIn("from=2026-08-25T00%3A00%3A00Z", transport.last_url)

    def test_converts_non_utc_datetime_to_utc(self) -> None:
        client, transport = self.make(SERIES_DE_BODY)
        client.series("DE", start=datetime(2026, 8, 25, 2, 0, tzinfo=timezone(timedelta(hours=2))))
        self.assertIn("from=2026-08-25T00%3A00%3A00Z", transport.last_url)

    def test_naive_datetime_treated_as_utc(self) -> None:
        client, transport = self.make(SERIES_DE_BODY)
        client.series("DE", start=datetime(2026, 8, 25, 0, 0))
        self.assertIn("from=2026-08-25T00%3A00%3A00Z", transport.last_url)

    def test_bad_timestamp_rejected_before_the_wire(self) -> None:
        # The API silently ignores an unparseable 'from' and substitutes its
        # own default window, so the SDK must refuse it locally.
        client, transport = self.make(SERIES_DE_BODY)
        with self.assertRaises(ValueError):
            client.series("DE", start="last tuesday")
        self.assertEqual(transport.requests, [])

    def test_only_end_supplied(self) -> None:
        client, transport = self.make(SERIES_DE_BODY)
        client.series("DE", end="2026-08-26T00:00:00Z")
        self.assertNotIn("from=", transport.last_url)
        self.assertIn("to=", transport.last_url)

    def test_blank_zone_rejected(self) -> None:
        client, transport = self.make(SERIES_DE_BODY)
        with self.assertRaises(ValueError):
            client.series("")
        self.assertEqual(transport.requests, [])

    def test_unknown_zone_yields_empty_series_not_an_error(self) -> None:
        # Documented upstream quirk: /v1/intensity answers 200 + [] for a bad
        # zone, so it cannot be told apart from an empty window.
        client, _ = self.make(SERIES_EMPTY_BODY)
        series = client.series("ZZ")
        self.assertEqual(len(series), 0)
        self.assertEqual(series.count, 0)

    def test_truncated_response_is_gated(self) -> None:
        client, _ = self.make(SERIES_TRUNCATED_BODY)
        series = client.series("DE")
        self.assertTrue(series.truncated)
        with self.assertRaises(TruncatedSeriesError):
            list(series)

    def test_allow_truncated_pre_acknowledges(self) -> None:
        client, _ = self.make(SERIES_TRUNCATED_BODY)
        series = client.series("DE", allow_truncated=True)
        self.assertTrue(series.truncated)
        self.assertEqual(len(list(series)), 2)


class TestHealth(ClientTestCase):
    def test_health_true(self) -> None:
        client, transport = self.make({"ok": True, "ts": "2026-08-26T01:00:00.000Z"})
        self.assertTrue(client.health())
        self.assertEqual(transport.last_url, "https://api.gridcarbon.dev/v1/health")

    def test_health_false(self) -> None:
        client, _ = self.make({"ok": False})
        self.assertFalse(client.health())


# --------------------------------------------------------------------------
# Client: failure modes
# --------------------------------------------------------------------------


class TestErrorHandling(ClientTestCase):
    def test_500_raises_api_error_with_status_and_message(self) -> None:
        client, _ = self.make(http_error(500, {"error": "internal"}))
        with self.assertRaises(ApiError) as ctx:
            client.zones()
        self.assertEqual(ctx.exception.status, 500)
        self.assertEqual(ctx.exception.message, "internal")
        self.assertIn("500", str(ctx.exception))

    def test_400_missing_param_message_is_surfaced(self) -> None:
        client, _ = self.make(http_error(400, {"error": "missing required param: zone"}))
        with self.assertRaises(ApiError) as ctx:
            client.series("DE")
        self.assertEqual(ctx.exception.message, "missing required param: zone")

    def test_hint_is_appended_to_message(self) -> None:
        client, _ = self.make(http_error(404, NOT_FOUND_BODY))
        with self.assertRaises(ApiError) as ctx:
            client.zones()
        self.assertIn("not found", ctx.exception.message)
        self.assertIn("see GET /v1", ctx.exception.message)
        self.assertEqual(ctx.exception.payload, NOT_FOUND_BODY)

    def test_non_json_error_body_degrades_gracefully(self) -> None:
        client, _ = self.make(http_error(502, b"<html>bad gateway</html>"))
        with self.assertRaises(ApiError) as ctx:
            client.zones()
        self.assertEqual(ctx.exception.status, 502)
        self.assertIn("bad gateway", ctx.exception.message)
        self.assertIsNone(ctx.exception.payload)

    def test_empty_error_body_degrades_gracefully(self) -> None:
        client, _ = self.make(http_error(503, b""))
        with self.assertRaises(ApiError) as ctx:
            client.zones()
        self.assertEqual(ctx.exception.status, 503)
        self.assertTrue(ctx.exception.message)

    def test_socket_timeout_raises_gridcarbon_timeout(self) -> None:
        client, _ = self.make(socket.timeout("timed out"))
        with self.assertRaises(GridCarbonTimeout):
            client.zones()

    def test_urlerror_wrapping_timeout_raises_gridcarbon_timeout(self) -> None:
        client, _ = self.make(URLError(socket.timeout("timed out")))
        with self.assertRaises(GridCarbonTimeout):
            client.zones()

    def test_timeout_is_catchable_as_builtin_timeout_error(self) -> None:
        client, _ = self.make(socket.timeout("timed out"))
        with self.assertRaises(TimeoutError):
            client.zones()

    def test_dns_failure_raises_network_error(self) -> None:
        client, _ = self.make(URLError("Name or service not known"))
        with self.assertRaises(NetworkError) as ctx:
            client.zones()
        self.assertIn("could not reach", str(ctx.exception))

    def test_connection_refused_raises_network_error(self) -> None:
        client, _ = self.make(ConnectionRefusedError("refused"))
        with self.assertRaises(NetworkError):
            client.zones()

    def test_all_errors_share_one_base(self) -> None:
        cases = [
            http_error(500, {"error": "boom"}),
            socket.timeout("t"),
            URLError("down"),
        ]
        for failure in cases:
            client, _ = self.make(failure)
            with self.assertRaises(GridCarbonError):
                client.zones()

    def test_non_object_json_body_raises_api_error(self) -> None:
        client, _ = self.make([1, 2, 3])
        with self.assertRaises(ApiError):
            client.zones()


class TestGbComparabilityWorkflow(ClientTestCase):
    """The documented safe way to rank zones."""

    def test_filtering_on_is_lifecycle_excludes_gb(self) -> None:
        client, _ = self.make(LATEST_ALL_BODY)
        readings = client.latest()
        comparable = [r for r in readings if r.is_lifecycle]
        self.assertNotIn("GB", [r.zone for r in comparable])
        self.assertEqual(len(comparable), 3)
        cleanest = min(comparable, key=lambda r: r.gco2eq_kwh)
        # GB's 114 would have won on raw value, but it is not comparable.
        self.assertEqual(cleanest.zone, "AT")


if __name__ == "__main__":
    unittest.main()
