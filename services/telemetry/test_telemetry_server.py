import datetime as dt
import tempfile
import unittest
from pathlib import Path

from telemetry_server import TelemetryDatabase, encode_password, masked_ip, validate_payload, verify_password


def payload(identifier: str = "8d21d0ef-23ae-4df0-a090-6b7d44d4a111") -> dict:
    return {
        "anonymousId": identifier,
        "date": dt.datetime.now(dt.timezone.utc).date().isoformat(),
        "appVersion": "0.6.6",
        "androidApi": 35,
        "mode": "offline",
        "locale": "zh-CN",
        "timezone": "Asia/Shanghai",
        "dailyMetrics": [
            {
                "date": dt.datetime.now(dt.timezone.utc).date().isoformat(),
                "mode": "offline",
                "callCount": 4,
                "connectedCount": 2,
                "notConnectedCount": 1,
                "unknownCount": 1,
                "totalDurationSeconds": 180,
            }
        ],
    }


class TelemetryServerTest(unittest.TestCase):
    def test_password_hash_round_trip(self) -> None:
        encoded = encode_password("correct horse battery staple")
        self.assertTrue(verify_password("correct horse battery staple", encoded))
        self.assertFalse(verify_password("incorrect password", encoded))

    def test_ip_masking(self) -> None:
        self.assertEqual("203.0.113.*", masked_ip("203.0.113.89"))
        self.assertEqual("2001:db8:abcd::/48", masked_ip("2001:db8:abcd:12::5"))
        self.assertEqual("unknown", masked_ip("not-an-ip"))

    def test_payload_rejects_sensitive_or_inconsistent_fields(self) -> None:
        valid = payload()
        self.assertEqual(4, validate_payload(valid)["dailyMetrics"][0]["callCount"])
        valid["phone"] = "13800138000"
        with self.assertRaisesRegex(ValueError, "unsupported fields"):
            validate_payload(valid)
        invalid = payload()
        invalid["dailyMetrics"][0]["connectedCount"] = 4
        with self.assertRaisesRegex(ValueError, "must equal"):
            validate_payload(invalid)

    def test_ingest_is_idempotent_and_dashboard_is_aggregated(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            database = TelemetryDatabase(Path(directory) / "telemetry.sqlite3", b"identifier-secret", 30)
            report = validate_payload(payload())
            database.ingest(report, "203.0.113.89", "CN")
            database.ingest(report, "203.0.113.89", "CN")
            dashboard = database.dashboard(30)
            self.assertEqual(1, dashboard["metrics"]["activeToday"])
            self.assertEqual(1, dashboard["metrics"]["observedInstallations"])
            self.assertEqual(4, dashboard["metrics"]["callCount"])
            self.assertEqual("203.0.113.*", dashboard["recent"][0]["ip_masked"])
            self.assertNotIn(report["anonymousId"], str(dashboard))


if __name__ == "__main__":
    unittest.main()
