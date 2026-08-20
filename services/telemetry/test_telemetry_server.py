from __future__ import annotations

import datetime as dt
import http.client
import re
import tempfile
import threading
import unittest
import urllib.parse
from pathlib import Path

from telemetry_server import (
    Config,
    TelemetryDatabase,
    TelemetryServer,
    encode_password,
    masked_ip,
    validate_payload,
    verify_password,
)


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
            database = TelemetryDatabase(
                Path(directory) / "telemetry.sqlite3",
                b"identifier-secret",
                30,
                encode_password("initial administrator password"),
            )
            report = validate_payload(payload())
            database.ingest(report, "203.0.113.89", "CN")
            database.ingest(report, "203.0.113.89", "CN")
            dashboard = database.dashboard(30)
            self.assertEqual(1, dashboard["metrics"]["activeToday"])
            self.assertEqual(1, dashboard["metrics"]["observedInstallations"])
            self.assertEqual(4, dashboard["metrics"]["callCount"])
            self.assertEqual("203.0.113.*", dashboard["recent"][0]["ip_masked"])
            self.assertNotIn(report["anonymousId"], str(dashboard))

    def test_changed_admin_password_persists_and_increments_session_version(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "telemetry.sqlite3"
            initial_hash = encode_password("initial administrator password")
            database = TelemetryDatabase(path, b"identifier-secret", 30, initial_hash)

            stored_hash, session_version = database.admin_auth_state()
            self.assertTrue(verify_password("initial administrator password", stored_hash))
            self.assertEqual(1, session_version)
            self.assertIsNone(database.change_admin_password("incorrect password", "replacement password value"))
            self.assertEqual(2, database.change_admin_password(
                "initial administrator password",
                "replacement password value",
            ))

            reopened = TelemetryDatabase(
                path,
                b"identifier-secret",
                30,
                encode_password("different environment seed"),
            )
            replacement_hash, session_version = reopened.admin_auth_state()
            self.assertTrue(verify_password("replacement password value", replacement_hash))
            self.assertFalse(verify_password("different environment seed", replacement_hash))
            self.assertEqual(2, session_version)

    def test_password_change_replaces_session_and_invalidates_old_credentials(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            config = Config(
                bind_host="127.0.0.1",
                bind_port=0,
                database_path=Path(directory) / "telemetry.sqlite3",
                admin_username="admin",
                admin_password_hash=encode_password("initial administrator password"),
                session_secret=b"session-secret-for-tests",
                identifier_secret=b"identifier-secret-for-tests",
                retention_days=30,
                static_dir=Path(__file__).with_name("static"),
                secure_cookie=False,
            )
            server = TelemetryServer(config)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            connection = http.client.HTTPConnection(*server.server_address, timeout=5)

            def request(
                method: str,
                path: str,
                values: dict[str, str] | None = None,
                cookie: str | None = None,
            ) -> tuple[int, dict[str, str], bytes]:
                body = urllib.parse.urlencode(values).encode() if values is not None else None
                headers = {"Content-Type": "application/x-www-form-urlencoded"}
                if cookie is not None:
                    headers["Cookie"] = cookie
                connection.request(method, path, body=body, headers=headers)
                response = connection.getresponse()
                response_headers = {name.lower(): value for name, value in response.getheaders()}
                return response.status, response_headers, response.read()

            try:
                status, headers, _ = request(
                    "POST",
                    "/login",
                    {"username": "admin", "password": "initial administrator password"},
                )
                self.assertEqual(303, status)
                old_cookie = headers["set-cookie"].split(";", 1)[0]

                status, _, dashboard = request("GET", "/admin", cookie=old_cookie)
                self.assertEqual(200, status)
                csrf_match = re.search(rb'name="csrf" value="([a-f0-9]+)"', dashboard)
                self.assertIsNotNone(csrf_match)
                csrf = csrf_match.group(1).decode()

                status, headers, body = request(
                    "POST",
                    "/admin/api/password",
                    {
                        "csrf": csrf,
                        "currentPassword": "initial administrator password",
                        "newPassword": "replacement password value",
                    },
                    old_cookie,
                )
                self.assertEqual(200, status)
                self.assertEqual(b'{"changed":true}', body)
                new_cookie = headers["set-cookie"].split(";", 1)[0]
                self.assertNotEqual(old_cookie, new_cookie)

                self.assertEqual(303, request("GET", "/admin", cookie=old_cookie)[0])
                self.assertEqual(200, request("GET", "/admin", cookie=new_cookie)[0])
                self.assertEqual(303, request(
                    "POST",
                    "/login",
                    {"username": "admin", "password": "initial administrator password"},
                )[0])
                status, headers, _ = request(
                    "POST",
                    "/login",
                    {"username": "admin", "password": "replacement password value"},
                )
                self.assertEqual(303, status)
                self.assertEqual("/admin", headers["location"])
            finally:
                connection.close()
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)


if __name__ == "__main__":
    unittest.main()
