"""
tests/test_m3_sync_telemetry.py

Automated test verifying Milestone 3 Feature 7:
Backend Garmin telemetry parsing in src/ingestion/sync.py:
- Ingests metricDescriptors and activityDetailMetrics if available, populating telemetry_stream.
- Populates GPS points with real elevation and HR from telemetry_stream rather than flat 0.0 and avg_hr.
- Strength activities tracking duration, HR and training load only (gps_track and telemetry_stream suppressed).
"""

import unittest
from src.ingestion.sync import parse_garmin_activity_detail_metrics, normalize_garmin_activity


class TestGarminTelemetryParsing(unittest.TestCase):
    def test_parse_metric_descriptors_and_detail_metrics(self):
        details = {
            "metricDescriptors": [
                {"metricsIndex": 0, "key": "directTimestamp"},
                {"metricsIndex": 1, "key": "directLatitude"},
                {"metricsIndex": 2, "key": "directLongitude"},
                {"metricsIndex": 3, "key": "directElevation"},
                {"metricsIndex": 4, "key": "directHeartRate"},
                {"metricsIndex": 5, "key": "directSpeed"},
                {"metricsIndex": 6, "key": "directRunCadence"},
            ],
            "activityDetailMetrics": [
                {"metrics": [1698765432000, 39.4699, -0.3763, 15.2, 142, 3.25, 174]},
                {"metrics": [1698765433000, 39.4700, -0.3764, 15.8, 145, 3.30, 175]},
                {"metrics": [1698765434000, 39.4701, -0.3765, 16.1, 148, 3.35, 176]},
            ],
        }

        stream = parse_garmin_activity_detail_metrics(details, dur_sec=3, avg_hr=145)
        self.assertIsNotNone(stream)
        self.assertEqual(stream["time"], [0, 1, 2])
        self.assertEqual(stream["elevation"], [15.2, 15.8, 16.1])
        self.assertEqual(stream["hr"], [142, 145, 148])
        self.assertEqual(stream["speed"], [3.25, 3.30, 3.35])
        self.assertEqual(stream["cadence"], [174, 175, 176])
        self.assertIn("_geo_points", stream)
        self.assertEqual(len(stream["_geo_points"]), 3)

    def test_normalize_garmin_activity_with_telemetry_metrics(self):
        raw_payload = {
            "summary": {
                "activityId": 123456789,
                "activityName": "Valencia 10k Tempo",
                "activityType": {"typeKey": "running"},
                "duration": 2400,
                "distance": 10000,
                "averageHR": 160,
                "maxHR": 178,
                "elevationGain": 35,
            },
            "details": {
                "metricDescriptors": [
                    {"metricsIndex": 0, "key": "directTimestamp"},
                    {"metricsIndex": 1, "key": "directElevation"},
                    {"metricsIndex": 2, "key": "directHeartRate"},
                    {"metricsIndex": 3, "key": "directSpeed"},
                    {"metricsIndex": 4, "key": "directRunCadence"},
                ],
                "activityDetailMetrics": [
                    {"metrics": [0, 20.0, 150, 4.0, 172]},
                    {"metrics": [1, 22.5, 155, 4.2, 174]},
                    {"metrics": [2, 25.0, 160, 4.1, 176]},
                ],
            },
        }

        act = normalize_garmin_activity(raw_payload)
        self.assertIsNotNone(act.get("telemetry_stream"))
        stream = act["telemetry_stream"]
        self.assertEqual(stream["elevation"], [20.0, 22.5, 25.0])
        self.assertEqual(stream["hr"], [150, 155, 160])
        self.assertEqual(stream["speed"], [4.0, 4.2, 4.1])
        self.assertEqual(stream["cadence"], [172, 174, 176])

    def test_strength_activity_suppresses_telemetry_stream_and_gps(self):
        strength_payload = {
            "summary": {
                "activityId": 987654321,
                "activityName": "Upper Body Strength",
                "activityType": {"typeKey": "strength_training"},
                "duration": 3600,
                "averageHR": 125,
            },
            "details": {
                "metricDescriptors": [
                    {"metricsIndex": 0, "key": "directTimestamp"},
                    {"metricsIndex": 1, "key": "directHeartRate"},
                ],
                "activityDetailMetrics": [
                    {"metrics": [0, 120]},
                    {"metrics": [60, 130]},
                ],
            },
        }
        act = normalize_garmin_activity(strength_payload)
        self.assertEqual(act["sport"], "strength")
        self.assertIsNone(act.get("telemetry_stream"))
        self.assertIsNone(act.get("gps_track"))
        self.assertEqual(act["distance_meters"], 0.0)


if __name__ == "__main__":
    unittest.main()
