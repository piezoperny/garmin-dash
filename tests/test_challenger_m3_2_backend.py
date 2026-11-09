"""
tests/test_challenger_m3_2_backend.py

Adversarial Backend Test Suite for Milestone 3 (Challenger M3-2):
Targeting src/ingestion/sync.py:
1. Malformed metricDescriptors (non-list, non-dict items, non-integer indices, missing/invalid keys).
2. Empty or corrupted activityDetailMetrics (None, [], items with non-list metrics, nulls).
3. Corrupted sensor values within metrics lists:
   - "null", "N/A", "NaN", empty string, invalid float/int for elevation, HR, speed, cadence, distance, coordinates.
4. Timestamp parsing across millisecond epoch, second epoch, relative seconds, invalid strings, None.
5. Integration with normalize_garmin_activity under corrupted details payloads.
6. Strength activity constraints: telemetry_stream and gps_track strictly suppressed even if detail metrics present.
"""

import unittest
from typing import Any, Dict
from src.ingestion.sync import (
    parse_garmin_activity_detail_metrics,
    normalize_garmin_activity,
)


class TestAdversarialSyncTelemetry(unittest.TestCase):

    # -------------------------------------------------------------------------
    # 1. Malformed metricDescriptors Tests
    # -------------------------------------------------------------------------
    def test_details_none_or_non_dict(self):
        """details parameter is None, string, or list - must not crash with AttributeError."""
        self.assertIsNone(parse_garmin_activity_detail_metrics(None))
        self.assertIsNone(parse_garmin_activity_detail_metrics("not_a_dict"))
        self.assertIsNone(parse_garmin_activity_detail_metrics([]))

    def test_descriptors_none_or_non_list(self):
        """metricDescriptors is None, dict, string, int - must safely return None."""
        details_none = {"metricDescriptors": None, "activityDetailMetrics": [{"metrics": [1]}]}
        self.assertIsNone(parse_garmin_activity_detail_metrics(details_none))

        details_str = {"metricDescriptors": "corrupt", "activityDetailMetrics": [{"metrics": [1]}]}
        self.assertIsNone(parse_garmin_activity_detail_metrics(details_str))

        details_dict = {"metricDescriptors": {"key": "val"}, "activityDetailMetrics": [{"metrics": [1]}]}
        self.assertIsNone(parse_garmin_activity_detail_metrics(details_dict))

    def test_descriptors_with_non_dict_items(self):
        """metricDescriptors containing None, strings, numbers - valid dicts should still be parsed."""
        details = {
            "metricDescriptors": [
                None,
                "invalid_str",
                123,
                [],
                {"metricsIndex": 0, "key": "directTimestamp"},
                {"metricsIndex": 1, "key": "directHeartRate"},
            ],
            "activityDetailMetrics": [
                {"metrics": [0, 140]},
                {"metrics": [1, 145]},
            ],
        }
        res = parse_garmin_activity_detail_metrics(details)
        self.assertIsNotNone(res)
        self.assertEqual(res["time"], [0, 1])
        self.assertEqual(res["hr"], [140, 145])

    def test_descriptors_with_non_integer_metricsIndex(self):
        """metricDescriptors with non-integer metricsIndex ('bad', None, [], {}) must not raise ValueError."""
        details = {
            "metricDescriptors": [
                {"metricsIndex": "bad_index", "key": "directTimestamp"},
                {"metricsIndex": None, "key": "directElevation"},
                {"metricsIndex": [1, 2], "key": "directSpeed"},
                {"metricsIndex": 0, "key": "directHeartRate"},
            ],
            "activityDetailMetrics": [
                {"metrics": [150]},
            ],
        }
        # Should not raise ValueError: invalid literal for int()
        res = parse_garmin_activity_detail_metrics(details)
        # Should parse directHeartRate at index 0
        if res is not None:
            self.assertEqual(res["hr"], [150])

    def test_descriptors_empty_or_no_keys(self):
        """metricDescriptors with missing keys or empty strings."""
        details = {
            "metricDescriptors": [
                {"metricsIndex": 0},
                {"key": ""},
                {"metricsIndex": 1, "key": None},
            ],
            "activityDetailMetrics": [
                {"metrics": [10, 20]},
            ],
        }
        # Nothing recognizable, should return either None or fallback with no metrics
        res = parse_garmin_activity_detail_metrics(details)
        # If time is synthesized or None, it must not throw
        self.assertTrue(res is None or isinstance(res, dict))

    # -------------------------------------------------------------------------
    # 2. Empty & Degenerate activityDetailMetrics Tests
    # -------------------------------------------------------------------------
    def test_detail_metrics_empty_or_none(self):
        """activityDetailMetrics is None, empty list, or non-list."""
        self.assertIsNone(parse_garmin_activity_detail_metrics({
            "metricDescriptors": [{"metricsIndex": 0, "key": "directTimestamp"}],
            "activityDetailMetrics": []
        }))
        self.assertIsNone(parse_garmin_activity_detail_metrics({
            "metricDescriptors": [{"metricsIndex": 0, "key": "directTimestamp"}],
            "activityDetailMetrics": None
        }))
        self.assertIsNone(parse_garmin_activity_detail_metrics({
            "metricDescriptors": [{"metricsIndex": 0, "key": "directTimestamp"}],
            "activityDetailMetrics": "corrupt_string"
        }))

    def test_detail_metrics_with_empty_or_none_items(self):
        """activityDetailMetrics contains None, {}, or non-list metrics."""
        details = {
            "metricDescriptors": [
                {"metricsIndex": 0, "key": "directTimestamp"},
                {"metricsIndex": 1, "key": "directHeartRate"},
            ],
            "activityDetailMetrics": [
                None,
                {},
                {"metrics": None},
                {"metrics": []},
                {"metrics": "not_a_list"},
                {"metrics": [0, 150]},
            ],
        }
        res = parse_garmin_activity_detail_metrics(details)
        self.assertIsNotNone(res)
        self.assertEqual(res["hr"], [150])
        self.assertEqual(res["time"], [0])

    # -------------------------------------------------------------------------
    # 3. Corrupted Metric Values ("null", "N/A", "NaN", strings)
    # -------------------------------------------------------------------------
    def test_corrupted_sensor_values(self):
        """Elevation, HR, Speed, Cadence, Distance containing 'null', 'N/A', strings, None."""
        details = {
            "metricDescriptors": [
                {"metricsIndex": 0, "key": "directTimestamp"},
                {"metricsIndex": 1, "key": "directElevation"},
                {"metricsIndex": 2, "key": "directHeartRate"},
                {"metricsIndex": 3, "key": "directSpeed"},
                {"metricsIndex": 4, "key": "directRunCadence"},
                {"metricsIndex": 5, "key": "directDistance"},
            ],
            "activityDetailMetrics": [
                {"metrics": [0, "null", "N/A", "corrupt", "none", "bad_dist"]},
                {"metrics": [1, None, None, None, None, None]},
                {"metrics": [2, 100.5, 155, 3.5, 175, 500.0]},
            ],
        }
        # Must not raise ValueError or TypeError
        res = parse_garmin_activity_detail_metrics(details, avg_hr=150)
        self.assertIsNotNone(res)
        self.assertEqual(len(res["time"]), 3)
        self.assertEqual(len(res["elevation"]), 3)
        self.assertEqual(len(res["hr"]), 3)
        self.assertEqual(len(res["speed"]), 3)
        self.assertEqual(len(res["cadence"]), 3)

        # Fallbacks for corrupted index 0
        self.assertEqual(res["elevation"][0], 0.0)
        self.assertEqual(res["hr"][0], 150)  # defaulted to avg_hr
        self.assertEqual(res["speed"][0], 0.0)
        self.assertEqual(res["cadence"][0], 0)

        # Valid values at index 2
        self.assertEqual(res["elevation"][2], 100.5)
        self.assertEqual(res["hr"][2], 155)
        self.assertEqual(res["speed"][2], 3.5)
        self.assertEqual(res["cadence"][2], 175)

    def test_corrupted_gps_coordinates(self):
        """directLatitude / directLongitude containing strings, NaNs, None, or out-of-range coords."""
        details = {
            "metricDescriptors": [
                {"metricsIndex": 0, "key": "directTimestamp"},
                {"metricsIndex": 1, "key": "directLatitude"},
                {"metricsIndex": 2, "key": "directLongitude"},
                {"metricsIndex": 3, "key": "directElevation"},
                {"metricsIndex": 4, "key": "directHeartRate"},
            ],
            "activityDetailMetrics": [
                {"metrics": [0, "bad_lat", "bad_lon", 10.0, 140]},
                {"metrics": [1, None, None, 11.0, 142]},
                {"metrics": [2, 0.0, 0.0, 12.0, 144]},  # 0,0 null island should be excluded
                {"metrics": [3, 39.4699, -0.3763, 13.0, 146]},  # valid Valencia coord
            ],
        }
        res = parse_garmin_activity_detail_metrics(details)
        self.assertIsNotNone(res)
        self.assertIn("_geo_points", res)
        # Only the valid coordinate should be kept
        self.assertEqual(len(res["_geo_points"]), 1)
        self.assertAlmostEqual(res["_geo_points"][0][0], 39.4699, places=4)
        self.assertAlmostEqual(res["_geo_points"][0][1], -0.3763, places=4)

    # -------------------------------------------------------------------------
    # 4. Timestamps Handling
    # -------------------------------------------------------------------------
    def test_timestamp_variations(self):
        """ms epoch, s epoch, relative, invalid timestamps."""
        # Millisecond epoch
        details_ms = {
            "metricDescriptors": [{"metricsIndex": 0, "key": "directTimestamp"}],
            "activityDetailMetrics": [
                {"metrics": [1700000000000]},
                {"metrics": [1700000005000]},
                {"metrics": [1700000010000]},
            ],
        }
        res_ms = parse_garmin_activity_detail_metrics(details_ms)
        self.assertEqual(res_ms["time"], [0, 5, 10])

        # Second epoch
        details_s = {
            "metricDescriptors": [{"metricsIndex": 0, "key": "directTimestamp"}],
            "activityDetailMetrics": [
                {"metrics": [1700000000]},
                {"metrics": [1700000005]},
            ],
        }
        res_s = parse_garmin_activity_detail_metrics(details_s)
        self.assertEqual(res_s["time"], [0, 5])

        # Invalid string timestamp with duration fallback
        details_corrupt_t = {
            "metricDescriptors": [{"metricsIndex": 0, "key": "directTimestamp"}],
            "activityDetailMetrics": [
                {"metrics": ["not_a_time"]},
                {"metrics": ["also_bad"]},
                {"metrics": ["still_bad"]},
            ],
        }
        res_corrupt = parse_garmin_activity_detail_metrics(details_corrupt_t, dur_sec=300)
        self.assertEqual(res_corrupt["time"], [0, 150, 300])

    # -------------------------------------------------------------------------
    # 5. Integration with normalize_garmin_activity
    # -------------------------------------------------------------------------
    def test_normalize_garmin_activity_adversarial_details(self):
        """normalize_garmin_activity must handle corrupt details without throwing unhandled exceptions."""
        corrupt_payloads = [
            {"summary": {"activityId": 101, "activityType": {"typeKey": "running"}}, "details": None},
            {"summary": {"activityId": 102, "activityType": {"typeKey": "running"}}, "details": "string_details"},
            {
                "summary": {"activityId": 103, "activityType": {"typeKey": "running"}},
                "details": {
                    "metricDescriptors": [{"metricsIndex": "invalid", "key": "directTimestamp"}],
                    "activityDetailMetrics": [{"metrics": ["corrupt"]}]
                }
            },
            {
                "summary": {"activityId": 104, "activityType": {"typeKey": "running"}},
                "details": {
                    "metricDescriptors": [{"metricsIndex": 0, "key": "directTimestamp"}],
                    "activityDetailMetrics": []
                }
            },
        ]
        for p in corrupt_payloads:
            norm = normalize_garmin_activity(p)
            self.assertIsNotNone(norm)
            self.assertEqual(norm["id"], str(p["summary"]["activityId"]))

    def test_strength_activity_telemetry_suppressed(self):
        """Strength activities must suppress telemetry_stream and gps_track even when detail metrics exist."""
        payload = {
            "summary": {
                "activityId": 999,
                "activityType": {"typeKey": "strength_training"},
                "duration": 3600,
                "averageHR": 130,
            },
            "details": {
                "metricDescriptors": [
                    {"metricsIndex": 0, "key": "directTimestamp"},
                    {"metricsIndex": 1, "key": "directHeartRate"},
                ],
                "activityDetailMetrics": [
                    {"metrics": [0, 125]},
                    {"metrics": [10, 135]},
                ],
            },
        }
        norm = normalize_garmin_activity(payload)
        self.assertEqual(norm["sport"], "strength")
        self.assertIsNone(norm.get("telemetry_stream"), "Strength activity must not have telemetry_stream")
        self.assertIsNone(norm.get("gps_track"), "Strength activity must not have gps_track")
        self.assertEqual(norm["distance_meters"], 0.0)


if __name__ == "__main__":
    unittest.main()
