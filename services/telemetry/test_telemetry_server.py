from __future__ import annotations

import datetime as dt
import http.client
import json
import re
import sqlite3
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
    validate_announcement,
    verify_password,
)


def payload(identifier: str = "8d21d0ef-23ae-4df0-a090-6b7d44d4a111") -> dict:
    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
    return {
        "anonymousId": identifier,
        "date": now.date().isoformat(),
        "appVersion": "0.6.6",
        "androidApi": 35,
        "mode": "offline",
        "locale": "zh-CN",
        "timezone": "Asia/Shanghai",
        "dailyMetrics": [
            {
                "date": now.date().isoformat(),
                "mode": "offline",
                "callCount": 4,
                "connectedCount": 2,
                "notConnectedCount": 1,
                "unknownCount": 1,
                "totalDurationSeconds": 180,
            }
        ],
        "locations": [
            {
                "date": now.date().isoformat(),
                "latitudeE7": 312_304_160,
                "longitudeE7": 1_214_737_010,
                "accuracyMeters": 32.5,
                "capturedAt": now.isoformat().replace("+00:00", "Z"),
            }
        ],
    }


class TelemetryServerTest(unittest.TestCase):
    def test_announcement_validation_and_storage(self) -> None:
        self.assertEqual(("系统 维护", "第一行\n第二行"), validate_announcement(
            "  系统   维护  ",
            "第一行\r\n第二行\n",
        ))
        with self.assertRaisesRegex(ValueError, "不能为空"):
            validate_announcement("", "正文")
        with self.assertRaisesRegex(ValueError, "不能超过"):
            validate_announcement("标题", "内容" * 1_001)

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "telemetry.sqlite3"
            database = TelemetryDatabase(
                path,
                b"identifier-secret",
                30,
                encode_password("initial administrator password"),
            )
            self.assertIsNone(database.latest_announcement())
            first = database.publish_announcement("第一则公告", "请阅读第一则公告。")
            second = database.publish_announcement("第二则公告", "请阅读第二则公告。")
            self.assertEqual(1, first["id"])
            self.assertEqual(1, first["revision"])
            self.assertTrue(first["active"])
            self.assertEqual(second, database.latest_announcement())
            stored = database.announcements()
            self.assertEqual([second["id"], first["id"]], [item["id"] for item in stored])
            self.assertTrue(stored[0]["active"])
            self.assertFalse(stored[1]["active"])

            updated = database.update_announcement(second["id"], "第二则公告（修订）", "修订后的正文。")
            self.assertIsNotNone(updated)
            self.assertEqual(2, updated["revision"])
            self.assertTrue(updated["active"])
            self.assertEqual(updated, database.latest_announcement())
            self.assertIsNone(database.update_announcement(999, "不存在", "不会保存"))
            self.assertFalse(database.delete_announcement(999))
            self.assertTrue(database.delete_announcement(second["id"]))
            self.assertIsNone(database.latest_announcement())
            self.assertFalse(database.announcements()[0]["active"])

    def test_legacy_announcement_table_is_migrated_without_losing_data(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "telemetry.sqlite3"
            with sqlite3.connect(path) as database:
                database.executescript(
                    """
                    CREATE TABLE announcements (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        title TEXT NOT NULL,
                        content TEXT NOT NULL,
                        published_at TEXT NOT NULL
                    );
                    INSERT INTO announcements (title, content, published_at)
                    VALUES ('旧公告一', '正文一', '2026-09-01T01:00:00Z');
                    INSERT INTO announcements (title, content, published_at)
                    VALUES ('旧公告二', '正文二', '2026-09-02T01:00:00Z');
                    """
                )

            migrated = TelemetryDatabase(
                path,
                b"identifier-secret",
                30,
                encode_password("initial administrator password"),
            )
            items = migrated.announcements()
            self.assertEqual([2, 1], [item["id"] for item in items])
            self.assertEqual([True, False], [item["active"] for item in items])
            self.assertEqual([1, 1], [item["revision"] for item in items])
            self.assertEqual(items[0]["publishedAt"], items[0]["updatedAt"])

            self.assertTrue(migrated.delete_announcement(2))
            reopened = TelemetryDatabase(
                path,
                b"identifier-secret",
                30,
                encode_password("initial administrator password"),
            )
            self.assertIsNone(reopened.latest_announcement())

    def test_password_hash_round_trip(self) -> None:
        encoded = encode_password("correct horse battery staple")
        self.assertTrue(verify_password("correct horse battery staple", encoded))
        self.assertFalse(verify_password("incorrect password", encoded))

    def test_ip_masking(self) -> None:
        self.assertEqual("203.0.113.*", masked_ip("203.0.113.89"))
        self.assertEqual("2001:db8:abcd::/48", masked_ip("2001:db8:abcd:12::5"))
        self.assertEqual("unknown", masked_ip("not-an-ip"))

    def test_payload_accepts_legacy_release_and_rejects_invalid_fields(self) -> None:
        valid = payload()
        self.assertEqual(4, validate_payload(valid)["dailyMetrics"][0]["callCount"])
        legacy = {
            "a": valid["anonymousId"],
            "b": valid["date"],
            "c": valid["androidApi"],
            "d": valid["mode"],
            "e": valid["locale"],
            "f": valid["timezone"],
            "g": [
                {
                    "a": valid["dailyMetrics"][0]["date"],
                    "b": valid["dailyMetrics"][0]["mode"],
                    "c": valid["dailyMetrics"][0]["callCount"],
                    "d": valid["dailyMetrics"][0]["connectedCount"],
                    "e": valid["dailyMetrics"][0]["notConnectedCount"],
                    "f": valid["dailyMetrics"][0]["unknownCount"],
                    "g": valid["dailyMetrics"][0]["totalDurationSeconds"],
                }
            ],
        }
        normalized_legacy = validate_payload(legacy)
        self.assertEqual("legacy", normalized_legacy["appVersion"])
        self.assertEqual(4, normalized_legacy["dailyMetrics"][0]["callCount"])
        legacy["h"] = [dict(zip("abcde", valid["locations"][0].values()))]
        normalized_v074 = validate_payload(legacy)
        self.assertEqual("0.7.4", normalized_v074["appVersion"])
        self.assertEqual(valid["locations"], normalized_v074["locations"])
        with tempfile.TemporaryDirectory() as directory:
            database = TelemetryDatabase(Path(directory) / "test.sqlite3", b"secret", 30, encode_password("test-password"))
            database.ingest(normalized_v074, "127.0.0.1", "CN")
            database.ingest(normalized_v074, "127.0.0.1", "CN")
            with sqlite3.connect(Path(directory) / "test.sqlite3") as db:
                self.assertEqual(1, db.execute("SELECT COUNT(*) FROM installation_locations").fetchone()[0])
        legacy["h"][0]["b"] = 900_000_001
        with self.assertRaisesRegex(ValueError, "out of range"):
            validate_payload(legacy)
        legacy["h"][0]["extra"] = True
        with self.assertRaisesRegex(ValueError, "invalid"):
            validate_payload(legacy)
        api_26 = payload()
        api_26["androidApi"] = 26
        self.assertEqual(26, validate_payload(api_26)["androidApi"])
        valid["phone"] = "13800138000"
        with self.assertRaisesRegex(ValueError, "unsupported fields"):
            validate_payload(valid)
        invalid = payload()
        invalid["dailyMetrics"][0]["connectedCount"] = 4
        with self.assertRaisesRegex(ValueError, "must equal"):
            validate_payload(invalid)

    def test_payload_validates_location_bounds_accuracy_and_timestamp(self) -> None:
        valid = validate_payload(payload())
        self.assertEqual(312_304_160, valid["locations"][0]["latitudeE7"])
        self.assertEqual(32.5, valid["locations"][0]["accuracyMeters"])

        for field, value in (
            ("latitudeE7", 900_000_001),
            ("longitudeE7", -1_800_000_001),
            ("accuracyMeters", float("inf")),
            ("accuracyMeters", -1),
        ):
            invalid = payload()
            invalid["locations"][0][field] = value
            with self.assertRaisesRegex(ValueError, "out of range"):
                validate_payload(invalid)
        invalid = payload()
        invalid["locations"][0]["capturedAt"] = "2026-09-18 12:00:00"
        with self.assertRaisesRegex(ValueError, "timezone"):
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
            map_devices = database.map_data(30, 14, (120, 30, 123, 33))
            self.assertEqual("devices", map_devices["mode"])
            self.assertEqual(1, len(map_devices["items"]))
            self.assertEqual(4, map_devices["items"][0]["calls"])
            self.assertEqual(1, map_devices["items"][0]["devices"])

            second = payload("5f3094e4-439a-49f7-a3a6-8af0f86c5c22")
            second["locations"][0]["latitudeE7"] += 100
            second["locations"][0]["longitudeE7"] += 100
            database.ingest(validate_payload(second), "203.0.113.90", "CN")
            clusters = database.map_data(30, 8, (120, 30, 123, 33))
            self.assertEqual("clusters", clusters["mode"])
            self.assertEqual(1, len(clusters["items"]))
            self.assertEqual(2, clusters["items"][0]["devices"])
            self.assertEqual(8, clusters["items"][0]["calls"])

            with database.connection() as stored:
                location_count = stored.execute(
                    "SELECT COUNT(*) AS value FROM installation_locations"
                ).fetchone()["value"]
            self.assertEqual(2, location_count)

    def test_location_retention_cleanup_runs_during_ingest(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            database = TelemetryDatabase(
                Path(directory) / "telemetry.sqlite3",
                b"identifier-secret",
                30,
                encode_password("initial administrator password"),
            )
            with database.connection() as stored:
                stored.execute(
                    """
                    INSERT INTO installation_locations (
                        install_hash, location_date, latitude_e7, longitude_e7,
                        accuracy_meters, captured_at, updated_at
                    ) VALUES ('old-install', '2020-01-01', 0, 0, 1, '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')
                    """
                )
            database.ingest(validate_payload(payload()), "203.0.113.89", "CN")
            with database.connection() as stored:
                old_count = stored.execute(
                    "SELECT COUNT(*) AS value FROM installation_locations WHERE install_hash = 'old-install'"
                ).fetchone()["value"]
            self.assertEqual(0, old_count)

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
                status, headers, body = request("GET", "/assets/qrcode.js")
                self.assertEqual(200, status)
                self.assertEqual("text/javascript; charset=utf-8", headers["content-type"])
                self.assertIn(b"var qrcode=", body)
                status, headers, _ = request("GET", "/assets/leaflet.js")
                self.assertEqual(200, status)
                self.assertEqual("text/javascript; charset=utf-8", headers["content-type"])
                status, headers, _ = request("GET", "/assets/leaflet.css")
                self.assertEqual(200, status)
                self.assertEqual("text/css; charset=utf-8", headers["content-type"])
                self.assertEqual(204, request("GET", "/api/app/v1/announcement/latest")[0])
                self.assertEqual(401, request("GET", "/admin/api/announcements")[0])
                self.assertEqual(401, request(
                    "GET", "/admin/api/map?days=30&zoom=8&bbox=120,30,123,33"
                )[0])

                status, headers, _ = request(
                    "POST",
                    "/login",
                    {"username": "admin", "password": "initial administrator password"},
                )
                self.assertEqual(303, status)
                old_cookie = headers["set-cookie"].split(";", 1)[0]

                status, _, dashboard = request("GET", "/admin", cookie=old_cookie)
                self.assertEqual(200, status)
                self.assertIn(b"webrd02.is.autonavi.com", dashboard)
                self.assertIn("高德地图".encode(), dashboard)
                csrf_match = re.search(rb'name="csrf" value="([a-f0-9]+)"', dashboard)
                self.assertIsNotNone(csrf_match)
                csrf = csrf_match.group(1).decode()

                status, _, body = request(
                    "GET",
                    "/admin/api/map?days=30&zoom=8&bbox=120,30,123,33",
                    cookie=old_cookie,
                )
                self.assertEqual(200, status)
                self.assertEqual("clusters", json.loads(body)["mode"])
                self.assertEqual(400, request(
                    "GET", "/admin/api/map?days=30&zoom=99&bbox=120,30,123,33", cookie=old_cookie
                )[0])

                status, _, body = request(
                    "POST",
                    "/admin/api/announcements",
                    {"csrf": csrf, "title": "", "content": "公告正文"},
                    old_cookie,
                )
                self.assertEqual(400, status)
                self.assertIn("不能为空", json.loads(body)["message"])

                status, _, body = request(
                    "POST",
                    "/admin/api/announcements",
                    {"csrf": csrf, "title": "服务通知", "content": "请所有坐席阅读。"},
                    old_cookie,
                )
                self.assertEqual(201, status)
                published = json.loads(body)
                self.assertEqual("服务通知", published["title"])

                status, _, body = request("GET", "/api/app/v1/announcement/latest")
                self.assertEqual(200, status)
                self.assertEqual(published, json.loads(body))
                status, _, body = request("GET", "/admin/api/announcements", cookie=old_cookie)
                self.assertEqual(200, status)
                self.assertEqual([published], json.loads(body)["items"])

                self.assertEqual(401, request(
                    "PUT",
                    f"/admin/api/announcements/{published['id']}",
                    {"csrf": csrf, "title": "未授权", "content": "不能修改"},
                )[0])
                self.assertEqual(403, request(
                    "DELETE",
                    f"/admin/api/announcements/{published['id']}",
                    {"csrf": "wrong"},
                    old_cookie,
                )[0])

                status, _, body = request(
                    "PUT",
                    f"/admin/api/announcements/{published['id']}",
                    {"csrf": csrf, "title": "服务通知（修订）", "content": "请重新阅读。"},
                    old_cookie,
                )
                self.assertEqual(200, status)
                updated_announcement = json.loads(body)
                self.assertEqual(2, updated_announcement["revision"])
                self.assertTrue(updated_announcement["active"])
                self.assertEqual("服务通知（修订）", updated_announcement["title"])
                self.assertEqual(updated_announcement, json.loads(request(
                    "GET", "/api/app/v1/announcement/latest"
                )[2]))

                self.assertEqual(404, request(
                    "PUT",
                    "/admin/api/announcements/999",
                    {"csrf": csrf, "title": "不存在", "content": "不会修改"},
                    old_cookie,
                )[0])
                self.assertEqual(404, request(
                    "DELETE",
                    "/admin/api/announcements/999",
                    {"csrf": csrf},
                    old_cookie,
                )[0])

                status, _, body = request(
                    "POST",
                    "/admin/api/announcements",
                    {"csrf": csrf, "title": "临时公告", "content": "删除后不恢复旧公告。"},
                    old_cookie,
                )
                self.assertEqual(201, status)
                latest = json.loads(body)
                self.assertEqual(1, latest["revision"])
                self.assertEqual(200, request(
                    "DELETE",
                    f"/admin/api/announcements/{latest['id']}",
                    {"csrf": csrf},
                    old_cookie,
                )[0])
                self.assertEqual(204, request("GET", "/api/app/v1/announcement/latest")[0])

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
