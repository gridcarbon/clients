"""LIVE smoke test -- makes real network calls to https://api.gridcarbon.dev.

Skipped by default. Opt in explicitly:

    GRIDCARBON_LIVE=1 python -m unittest tests.test_live_smoke -v

Everything here asserts on *shape and invariants*, never on specific intensity
values, because the live numbers change every hour.
"""

from __future__ import annotations

import os
import unittest
from datetime import datetime, timedelta, timezone

from gridcarbon import GridCarbon, Reading, Series, UnknownZone, Zone

LIVE = os.environ.get("GRIDCARBON_LIVE") == "1"
SKIP_REASON = "live network test; set GRIDCARBON_LIVE=1 to run"

VALID_SOURCES = {"entsoe", "eia", "uk-neso"}
VALID_METHODS = {"computed:v1", "upstream:uk-neso:actual", "upstream:uk-neso:forecast"}


@unittest.skipUnless(LIVE, SKIP_REASON)
class TestLiveApi(unittest.TestCase):
    """Hits the real API. Requires network."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.gc = GridCarbon(user_agent="gridcarbon-python/0.1.0 (live-smoke-test)")

    def test_health(self) -> None:
        self.assertTrue(self.gc.health())

    def test_zones(self) -> None:
        zones = self.gc.zones()
        self.assertGreaterEqual(len(zones), 40)
        self.assertTrue(all(isinstance(z, Zone) for z in zones))
        ids = {z.zone for z in zones}
        for expected in ("DE", "GB", "FR", "US-CAISO"):
            self.assertIn(expected, ids)
        self.assertTrue({z.source for z in zones} <= VALID_SOURCES)
        gb = next(z for z in zones if z.zone == "GB")
        self.assertEqual(gb.source, "uk-neso")
        self.assertEqual(gb.resolution_min, 30)
        self.assertFalse(gb.is_lifecycle)

    def test_latest_single_zone(self) -> None:
        reading = self.gc.latest("DE")
        self.assertIsInstance(reading, Reading)
        self.assertEqual(reading.zone, "DE")
        self.assertIsInstance(reading.gco2eq_kwh, float)
        self.assertGreater(reading.gco2eq_kwh, 0)
        self.assertLess(reading.gco2eq_kwh, 1200)
        self.assertIn(reading.method, VALID_METHODS)
        self.assertIsNotNone(reading.ts.tzinfo)
        self.assertTrue(reading.is_lifecycle)
        # Freshness: DE should be hours, not days, behind.
        self.assertGreater(reading.age, timedelta(0))
        self.assertLess(reading.age, timedelta(days=3))

    def test_latest_all_zones_have_zone_populated(self) -> None:
        readings = self.gc.latest()
        self.assertGreaterEqual(len(readings), 40)
        self.assertTrue(all(r.zone for r in readings))
        self.assertTrue(all(r.ts.tzinfo is not None for r in readings))
        self.assertTrue({r.method for r in readings} <= VALID_METHODS)

    def test_gb_is_flagged_as_not_lifecycle(self) -> None:
        gb = self.gc.latest("GB")
        self.assertEqual(gb.zone, "GB")
        self.assertFalse(gb.is_lifecycle)
        self.assertTrue(gb.method.startswith("upstream:uk-neso"))

    def test_unknown_zone_raises(self) -> None:
        with self.assertRaises(UnknownZone) as ctx:
            self.gc.latest("ZZ")
        self.assertEqual(ctx.exception.status, 404)

    def test_series_default_window(self) -> None:
        series = self.gc.series("DE")
        self.assertIsInstance(series, Series)
        self.assertEqual(series.zone, "DE")
        self.assertFalse(series.truncated)
        self.assertEqual(series.count, len(series))
        # The envelope-vs-item asymmetry must be normalised away.
        self.assertTrue(all(r.zone == "DE" for r in series))
        self.assertTrue(all(r.ts.tzinfo is not None for r in series))

    def test_series_is_chronological_and_within_the_window(self) -> None:
        end = datetime.now(timezone.utc)
        start = end - timedelta(hours=12)
        series = self.gc.series("FR", start=start, end=end)
        timestamps = [r.ts for r in series]
        self.assertEqual(timestamps, sorted(timestamps))
        for moment in timestamps:
            self.assertGreaterEqual(moment, series.start)
            self.assertLess(moment, series.end)  # half-open [from, to)

    def test_series_accepts_iso_strings(self) -> None:
        series = self.gc.series(
            "DE",
            start="2026-08-22T00:00:00Z",
            end="2026-08-22T06:00:00Z",
        )
        self.assertLessEqual(len(series), 7)
        self.assertTrue(all(r.zone == "DE" for r in series))

    def test_series_empty_window_is_handled(self) -> None:
        far_future = datetime.now(timezone.utc) + timedelta(days=365)
        series = self.gc.series("DE", start=far_future, end=far_future + timedelta(days=1))
        self.assertEqual(len(series), 0)
        self.assertFalse(series)
        self.assertIsNone(series.average())


if __name__ == "__main__":
    unittest.main()
