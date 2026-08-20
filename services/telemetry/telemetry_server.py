#!/usr/bin/env python3
"""Low-resource anonymous usage telemetry and administrator dashboard."""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import hashlib
import hmac
import html
import ipaddress
import json
import os
import re
import secrets
import sqlite3
import threading
import time
import urllib.parse
from dataclasses import dataclass
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


MAX_BODY_BYTES = 32 * 1024
SESSION_SECONDS = 12 * 60 * 60
ALLOWED_RANGE_DAYS = {7, 30, 90, 365}
IDENTIFIER_PATTERN = re.compile(r"^[0-9a-fA-F-]{16,64}$")
VERSION_PATTERN = re.compile(r"^[0-9A-Za-z][0-9A-Za-z._+-]{0,31}$")
LOCALE_PATTERN = re.compile(r"^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8}){0,2}$")
TIMEZONE_PATTERN = re.compile(r"^[A-Za-z0-9_+./:-]{1,64}$")
COUNTRY_PATTERN = re.compile(r"^[A-Z]{2}$")


def utc_now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def iso_timestamp(value: dt.datetime | None = None) -> str:
    return (value or utc_now()).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_date(value: Any, field: str) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{field} must be an ISO date")
    try:
        return dt.date.fromisoformat(value).isoformat()
    except ValueError as error:
        raise ValueError(f"{field} must be an ISO date") from error


def bounded_int(value: Any, field: str, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise ValueError(f"{field} is out of range")
    return value


def optional_text(value: Any, field: str, pattern: re.Pattern[str], fallback: str) -> str:
    if value is None:
        return fallback
    if not isinstance(value, str) or not pattern.fullmatch(value):
        raise ValueError(f"{field} is invalid")
    return value


def validate_payload(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("request body must be an object")
    allowed = {
        "anonymousId",
        "date",
        "appVersion",
        "androidApi",
        "mode",
        "locale",
        "timezone",
        "dailyMetrics",
    }
    if set(payload) - allowed:
        raise ValueError("request contains unsupported fields")
    anonymous_id = payload.get("anonymousId")
    if not isinstance(anonymous_id, str) or not IDENTIFIER_PATTERN.fullmatch(anonymous_id):
        raise ValueError("anonymousId is invalid")
    mode = payload.get("mode")
    if mode not in {"online", "offline"}:
        raise ValueError("mode is invalid")
    app_version = payload.get("appVersion")
    if not isinstance(app_version, str) or not VERSION_PATTERN.fullmatch(app_version):
        raise ValueError("appVersion is invalid")
    metrics = payload.get("dailyMetrics", [])
    if not isinstance(metrics, list) or len(metrics) > 31:
        raise ValueError("dailyMetrics is invalid")
    today = utc_now().date()
    active_date = parse_date(payload.get("date"), "date")
    if abs((dt.date.fromisoformat(active_date) - today).days) > 2:
        raise ValueError("date is outside the accepted clock-skew window")
    normalized_metrics: list[dict[str, Any]] = []
    for item in metrics:
        if not isinstance(item, dict) or set(item) != {
            "date",
            "mode",
            "callCount",
            "connectedCount",
            "notConnectedCount",
            "unknownCount",
            "totalDurationSeconds",
        }:
            raise ValueError("dailyMetrics item is invalid")
        metric_mode = item["mode"]
        if metric_mode not in {"online", "offline"}:
            raise ValueError("dailyMetrics mode is invalid")
        call_count = bounded_int(item["callCount"], "callCount", 0, 1_000_000)
        connected = bounded_int(item["connectedCount"], "connectedCount", 0, call_count)
        not_connected = bounded_int(item["notConnectedCount"], "notConnectedCount", 0, call_count)
        unknown = bounded_int(item["unknownCount"], "unknownCount", 0, call_count)
        if connected + not_connected + unknown != call_count:
            raise ValueError("dailyMetrics result counts must equal callCount")
        metric_date = parse_date(item["date"], "dailyMetrics.date")
        metric_date_value = dt.date.fromisoformat(metric_date)
        if metric_date_value < today - dt.timedelta(days=400) or metric_date_value > today + dt.timedelta(days=1):
            raise ValueError("dailyMetrics.date is outside the retention window")
        normalized_metrics.append(
            {
                "date": metric_date,
                "mode": metric_mode,
                "callCount": call_count,
                "connectedCount": connected,
                "notConnectedCount": not_connected,
                "unknownCount": unknown,
                "totalDurationSeconds": bounded_int(
                    item["totalDurationSeconds"], "totalDurationSeconds", 0, 100_000_000
                ),
            }
        )
    return {
        "anonymousId": anonymous_id,
        "date": active_date,
        "appVersion": app_version,
        "androidApi": bounded_int(payload.get("androidApi"), "androidApi", 31, 100),
        "mode": mode,
        "locale": optional_text(payload.get("locale"), "locale", LOCALE_PATTERN, "unknown"),
        "timezone": optional_text(payload.get("timezone"), "timezone", TIMEZONE_PATTERN, "unknown"),
        "dailyMetrics": normalized_metrics,
    }


def masked_ip(value: str) -> str:
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return "unknown"
    if isinstance(address, ipaddress.IPv4Address):
        parts = str(address).split(".")
        return f"{parts[0]}.{parts[1]}.{parts[2]}.*"
    network = ipaddress.ip_network(f"{address}/48", strict=False)
    return f"{network.network_address.compressed}/48"


def keyed_hash(secret: bytes, value: str) -> str:
    return hmac.new(secret, value.encode("utf-8"), hashlib.sha256).hexdigest()


def encode_password(password: str) -> str:
    if len(password) < 12:
        raise ValueError("password must contain at least 12 characters")
    salt = secrets.token_bytes(16)
    iterations = 600_000
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, iterations, dklen=32)
    return "pbkdf2_sha256$%d$%s$%s" % (
        iterations,
        base64.urlsafe_b64encode(salt).decode().rstrip("="),
        base64.urlsafe_b64encode(digest).decode().rstrip("="),
    )


def verify_password(password: str, encoded: str) -> bool:
    try:
        algorithm, iterations_text, salt_text, digest_text = encoded.split("$")
        if algorithm != "pbkdf2_sha256":
            return False
        decode = lambda value: base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
        expected = decode(digest_text)
        actual = hashlib.pbkdf2_hmac(
            "sha256", password.encode(), decode(salt_text), int(iterations_text), dklen=len(expected)
        )
        return hmac.compare_digest(expected, actual)
    except (ValueError, TypeError):
        return False


@dataclass(frozen=True)
class Config:
    bind_host: str
    bind_port: int
    database_path: Path
    admin_username: str
    admin_password_hash: str
    session_secret: bytes
    identifier_secret: bytes
    retention_days: int
    static_dir: Path
    secure_cookie: bool

    @classmethod
    def from_environment(cls) -> "Config":
        required = ["TELEMETRY_ADMIN_PASSWORD_HASH", "TELEMETRY_SESSION_SECRET", "TELEMETRY_IDENTIFIER_SECRET"]
        missing = [name for name in required if not os.environ.get(name)]
        if missing:
            raise RuntimeError(f"Missing environment variables: {', '.join(missing)}")
        return cls(
            bind_host=os.environ.get("TELEMETRY_BIND_HOST", "127.0.0.1"),
            bind_port=int(os.environ.get("TELEMETRY_BIND_PORT", "18820")),
            database_path=Path(os.environ.get("TELEMETRY_DATABASE_PATH", "./telemetry.sqlite3")),
            admin_username=os.environ.get("TELEMETRY_ADMIN_USERNAME", "admin"),
            admin_password_hash=os.environ["TELEMETRY_ADMIN_PASSWORD_HASH"],
            session_secret=os.environ["TELEMETRY_SESSION_SECRET"].encode(),
            identifier_secret=os.environ["TELEMETRY_IDENTIFIER_SECRET"].encode(),
            retention_days=max(7, min(365, int(os.environ.get("TELEMETRY_DETAIL_RETENTION_DAYS", "30")))),
            static_dir=Path(os.environ.get("TELEMETRY_STATIC_DIR", Path(__file__).with_name("static"))),
            secure_cookie=os.environ.get("TELEMETRY_SECURE_COOKIE", "true").lower() not in {"0", "false", "no"},
        )


class TelemetryDatabase:
    def __init__(self, path: Path, identifier_secret: bytes, retention_days: int) -> None:
        self.path = path
        self.identifier_secret = identifier_secret
        self.retention_days = retention_days
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.initialize()

    def connection(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=5)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA busy_timeout=5000")
        return connection

    def initialize(self) -> None:
        with self.connection() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("PRAGMA synchronous=NORMAL")
            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS installation_days (
                    install_hash TEXT NOT NULL,
                    active_date TEXT NOT NULL,
                    first_seen_at TEXT NOT NULL,
                    last_seen_at TEXT NOT NULL,
                    app_version TEXT NOT NULL,
                    android_api INTEGER NOT NULL,
                    mode TEXT NOT NULL,
                    locale TEXT NOT NULL,
                    timezone TEXT NOT NULL,
                    country_code TEXT NOT NULL,
                    ip_hash TEXT NOT NULL,
                    ip_masked TEXT NOT NULL,
                    PRIMARY KEY (install_hash, active_date)
                );
                CREATE INDEX IF NOT EXISTS installation_days_date ON installation_days(active_date);
                CREATE INDEX IF NOT EXISTS installation_days_last_seen ON installation_days(last_seen_at);

                CREATE TABLE IF NOT EXISTS installations (
                    install_hash TEXT PRIMARY KEY,
                    first_seen_at TEXT NOT NULL,
                    last_seen_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS daily_call_metrics (
                    install_hash TEXT NOT NULL,
                    metric_date TEXT NOT NULL,
                    mode TEXT NOT NULL,
                    call_count INTEGER NOT NULL,
                    connected_count INTEGER NOT NULL,
                    not_connected_count INTEGER NOT NULL,
                    unknown_count INTEGER NOT NULL,
                    total_duration_seconds INTEGER NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (install_hash, metric_date, mode)
                );
                CREATE INDEX IF NOT EXISTS daily_call_metrics_date ON daily_call_metrics(metric_date);
                """
            )

    def ingest(self, payload: dict[str, Any], client_ip: str, country_code: str) -> None:
        now = iso_timestamp()
        install_hash = keyed_hash(self.identifier_secret, payload["anonymousId"])
        ip_hash = keyed_hash(self.identifier_secret, client_ip or "unknown")
        country = country_code if COUNTRY_PATTERN.fullmatch(country_code) else "ZZ"
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute(
                """
                INSERT INTO installations (install_hash, first_seen_at, last_seen_at) VALUES (?, ?, ?)
                ON CONFLICT(install_hash) DO UPDATE SET last_seen_at=excluded.last_seen_at
                """,
                (install_hash, now, now),
            )
            db.execute(
                """
                INSERT INTO installation_days (
                    install_hash, active_date, first_seen_at, last_seen_at, app_version,
                    android_api, mode, locale, timezone, country_code, ip_hash, ip_masked
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(install_hash, active_date) DO UPDATE SET
                    last_seen_at=excluded.last_seen_at,
                    app_version=excluded.app_version,
                    android_api=excluded.android_api,
                    mode=excluded.mode,
                    locale=excluded.locale,
                    timezone=excluded.timezone,
                    country_code=excluded.country_code,
                    ip_hash=excluded.ip_hash,
                    ip_masked=excluded.ip_masked
                """,
                (
                    install_hash,
                    payload["date"],
                    now,
                    now,
                    payload["appVersion"],
                    payload["androidApi"],
                    payload["mode"],
                    payload["locale"],
                    payload["timezone"],
                    country,
                    ip_hash,
                    masked_ip(client_ip),
                ),
            )
            for metric in payload["dailyMetrics"]:
                db.execute(
                    """
                    INSERT INTO daily_call_metrics (
                        install_hash, metric_date, mode, call_count, connected_count,
                        not_connected_count, unknown_count, total_duration_seconds, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(install_hash, metric_date, mode) DO UPDATE SET
                        call_count=MAX(call_count, excluded.call_count),
                        connected_count=MAX(connected_count, excluded.connected_count),
                        not_connected_count=MAX(not_connected_count, excluded.not_connected_count),
                        unknown_count=MAX(unknown_count, excluded.unknown_count),
                        total_duration_seconds=MAX(total_duration_seconds, excluded.total_duration_seconds),
                        updated_at=excluded.updated_at
                    """,
                    (
                        install_hash,
                        metric["date"],
                        metric["mode"],
                        metric["callCount"],
                        metric["connectedCount"],
                        metric["notConnectedCount"],
                        metric["unknownCount"],
                        metric["totalDurationSeconds"],
                        now,
                    ),
                )
            cutoff = (utc_now().date() - dt.timedelta(days=self.retention_days)).isoformat()
            db.execute("DELETE FROM installation_days WHERE active_date < ?", (cutoff,))

    def dashboard(self, days: int) -> dict[str, Any]:
        today = utc_now().date()
        start = (today - dt.timedelta(days=days - 1)).isoformat()
        today_text = today.isoformat()
        with self.connection() as db:
            summary = db.execute(
                """
                SELECT
                  COUNT(DISTINCT CASE WHEN active_date = ? THEN install_hash END) AS active_today,
                  COUNT(DISTINCT install_hash) AS active_range,
                  COUNT(DISTINCT ip_hash) AS ip_count
                FROM installation_days WHERE active_date >= ?
                """,
                (today_text, start),
            ).fetchone()
            all_time = db.execute("SELECT COUNT(*) AS value FROM installations").fetchone()
            calls = db.execute(
                """
                SELECT COALESCE(SUM(call_count), 0) AS calls,
                       COALESCE(SUM(connected_count), 0) AS connected,
                       COALESCE(SUM(not_connected_count), 0) AS not_connected,
                       COALESCE(SUM(unknown_count), 0) AS unknown,
                       COALESCE(SUM(total_duration_seconds), 0) AS duration
                FROM daily_call_metrics WHERE metric_date >= ?
                """,
                (start,),
            ).fetchone()
            denominator = calls["connected"] + calls["not_connected"]
            call_count = calls["calls"]
            metrics = {
                "activeToday": summary["active_today"],
                "activeRange": summary["active_range"],
                "observedInstallations": all_time["value"],
                "ipCount": summary["ip_count"],
                "callCount": call_count,
                "connectedCount": calls["connected"],
                "notConnectedCount": calls["not_connected"],
                "unknownCount": calls["unknown"],
                "connectionRate": calls["connected"] / denominator if denominator else 0,
                "totalDurationSeconds": calls["duration"],
                "averageDurationSeconds": calls["duration"] / calls["connected"] if calls["connected"] else 0,
            }
            trend_rows = db.execute(
                """
                WITH RECURSIVE dates(value) AS (
                    SELECT date(?) UNION ALL SELECT date(value, '+1 day') FROM dates WHERE value < date(?)
                ), active AS (
                    SELECT active_date, COUNT(DISTINCT install_hash) AS installations
                    FROM installation_days WHERE active_date >= ? GROUP BY active_date
                ), calls AS (
                    SELECT metric_date, SUM(call_count) AS call_count, SUM(connected_count) AS connected_count
                    FROM daily_call_metrics WHERE metric_date >= ? GROUP BY metric_date
                )
                SELECT dates.value AS date, COALESCE(active.installations, 0) AS installations,
                       COALESCE(calls.call_count, 0) AS calls, COALESCE(calls.connected_count, 0) AS connected
                FROM dates LEFT JOIN active ON active.active_date=dates.value
                           LEFT JOIN calls ON calls.metric_date=dates.value ORDER BY dates.value
                """,
                (start, today_text, start, start),
            ).fetchall()
            dimensions: dict[str, list[dict[str, Any]]] = {}
            for name, column in {
                "versions": "app_version",
                "modes": "mode",
                "countries": "country_code",
                "timezones": "timezone",
                "androidVersions": "android_api",
            }.items():
                rows = db.execute(
                    f"""
                    SELECT {column} AS label, COUNT(DISTINCT install_hash) AS value
                    FROM installation_days WHERE active_date >= ?
                    GROUP BY {column} ORDER BY value DESC, label LIMIT 12
                    """,
                    (start,),
                ).fetchall()
                dimensions[name] = [dict(row) for row in rows]
            recent = db.execute(
                """
                SELECT substr(install_hash, 1, 10) AS installation, last_seen_at, app_version,
                       android_api, mode, locale, timezone, country_code, ip_masked
                FROM installation_days WHERE active_date >= ?
                ORDER BY last_seen_at DESC LIMIT 100
                """,
                (start,),
            ).fetchall()
        return {
            "generatedAt": iso_timestamp(),
            "rangeDays": days,
            "retentionDays": self.retention_days,
            "metrics": metrics,
            "trend": [dict(row) for row in trend_rows],
            "dimensions": dimensions,
            "recent": [dict(row) for row in recent],
            "notice": "仅统计主动开启匿名使用统计的安装；IP 已脱敏，地区为国家/时区级估算。",
        }


class LoginLimiter:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.attempts: dict[str, list[float]] = {}

    def allowed(self, client_ip: str) -> bool:
        cutoff = time.time() - 15 * 60
        with self.lock:
            values = [value for value in self.attempts.get(client_ip, []) if value >= cutoff]
            self.attempts[client_ip] = values
            return len(values) < 8

    def failed(self, client_ip: str) -> None:
        with self.lock:
            self.attempts.setdefault(client_ip, []).append(time.time())


class TelemetryHandler(BaseHTTPRequestHandler):
    server_version = "CallTelemetry/1"
    sys_version = ""
    protocol_version = "HTTP/1.1"

    def version_string(self) -> str:
        return self.server_version

    @property
    def app(self) -> "TelemetryServer":
        return self.server  # type: ignore[return-value]

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"{self.log_date_time_string()} {masked_ip(self.client_ip())} {fmt % args}", flush=True)

    def client_ip(self) -> str:
        value = self.headers.get("X-Client-IP", self.client_address[0]).strip()
        try:
            return str(ipaddress.ip_address(value))
        except ValueError:
            return self.client_address[0]

    def send_common_headers(self, content_type: str, length: int) -> None:
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; "
            "img-src 'none'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        )

    def respond(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_common_headers(content_type, len(body))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def json_response(self, status: int, value: Any) -> None:
        self.respond(status, json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode(), "application/json; charset=utf-8")

    def redirect(self, location: str) -> None:
        self.send_response(HTTPStatus.SEE_OTHER)
        self.send_header("Location", location)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def session_payload(self) -> tuple[int, str] | None:
        cookie = SimpleCookie(self.headers.get("Cookie"))
        value = cookie.get("call_admin_session")
        if value is None:
            return None
        try:
            issued_text, nonce, signature = value.value.split(".")
            signed = f"{issued_text}.{nonce}".encode()
            expected = hmac.new(self.app.config.session_secret, signed, hashlib.sha256).hexdigest()
            issued = int(issued_text)
            if not hmac.compare_digest(signature, expected) or not 0 <= time.time() - issued <= SESSION_SECONDS:
                return None
            csrf = hmac.new(self.app.config.session_secret, f"csrf.{nonce}".encode(), hashlib.sha256).hexdigest()
            return issued, csrf
        except (ValueError, AttributeError):
            return None

    def require_session(self) -> tuple[int, str] | None:
        session = self.session_payload()
        if session is None:
            self.json_response(HTTPStatus.UNAUTHORIZED, {"message": "请先登录"})
        return session

    def read_body(self) -> bytes:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as error:
            raise ValueError("invalid content length") from error
        if not 0 < length <= MAX_BODY_BYTES:
            raise ValueError("request body size is invalid")
        return self.rfile.read(length)

    def do_GET(self) -> None:
        path = urllib.parse.urlsplit(self.path)
        if path.path == "/healthz":
            self.respond(HTTPStatus.OK, b"ok\n", "text/plain; charset=utf-8")
            return
        if path.path == "/":
            self.redirect("/admin" if self.session_payload() else "/login")
            return
        if path.path == "/login":
            if self.session_payload():
                self.redirect("/admin")
                return
            template = (self.app.config.static_dir / "login.html").read_text(encoding="utf-8")
            error_visible = "" if "error" in urllib.parse.parse_qs(path.query) else " hidden"
            body = template.replace("__ERROR_HIDDEN__", error_visible).encode()
            self.respond(HTTPStatus.OK, body, "text/html; charset=utf-8")
            return
        if path.path == "/admin":
            session = self.session_payload()
            if session is None:
                self.redirect("/login")
                return
            template = (self.app.config.static_dir / "dashboard.html").read_text(encoding="utf-8")
            body = template.replace("__CSRF_TOKEN__", html.escape(session[1], quote=True)).encode()
            self.respond(HTTPStatus.OK, body, "text/html; charset=utf-8")
            return
        if path.path == "/admin/api/dashboard":
            if self.require_session() is None:
                return
            query = urllib.parse.parse_qs(path.query)
            try:
                days = int(query.get("days", ["30"])[0])
            except ValueError:
                days = 30
            if days not in ALLOWED_RANGE_DAYS:
                self.json_response(HTTPStatus.BAD_REQUEST, {"message": "时间范围无效"})
                return
            self.json_response(HTTPStatus.OK, self.app.database.dashboard(days))
            return
        if path.path.startswith("/assets/"):
            name = path.path.removeprefix("/assets/")
            if name not in {"app.css", "dashboard.js"}:
                self.respond(HTTPStatus.NOT_FOUND, b"not found\n", "text/plain; charset=utf-8")
                return
            self.serve_static(name)
            return
        self.respond(HTTPStatus.NOT_FOUND, b"not found\n", "text/plain; charset=utf-8")

    def do_HEAD(self) -> None:
        self.do_GET()

    def serve_static(self, name: str) -> None:
        path = self.app.config.static_dir / name
        try:
            body = path.read_bytes()
        except FileNotFoundError:
            self.respond(HTTPStatus.NOT_FOUND, b"not found\n", "text/plain; charset=utf-8")
            return
        content_type = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "text/javascript; charset=utf-8",
        }.get(path.suffix, "application/octet-stream")
        self.respond(HTTPStatus.OK, body, content_type)

    def do_POST(self) -> None:
        path = urllib.parse.urlsplit(self.path).path
        if path == "/api/telemetry/v1/daily":
            self.handle_telemetry()
            return
        if path == "/login":
            self.handle_login()
            return
        if path == "/logout":
            session = self.session_payload()
            try:
                values = urllib.parse.parse_qs(self.read_body().decode())
            except (ValueError, UnicodeDecodeError):
                self.respond(HTTPStatus.BAD_REQUEST, b"bad request\n", "text/plain; charset=utf-8")
                return
            if session is None or not hmac.compare_digest(values.get("csrf", [""])[0], session[1]):
                self.respond(HTTPStatus.FORBIDDEN, b"forbidden\n", "text/plain; charset=utf-8")
                return
            self.send_response(HTTPStatus.SEE_OTHER)
            self.send_header("Location", "/login")
            secure = "; Secure" if self.app.config.secure_cookie else ""
            self.send_header("Set-Cookie", f"call_admin_session=; Path=/; Max-Age=0; HttpOnly{secure}; SameSite=Strict")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.respond(HTTPStatus.NOT_FOUND, b"not found\n", "text/plain; charset=utf-8")

    def handle_telemetry(self) -> None:
        if self.headers.get_content_type() != "application/json":
            self.json_response(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, {"message": "Content-Type must be application/json"})
            return
        try:
            payload = validate_payload(json.loads(self.read_body()))
            country = self.headers.get("X-Country-Code", "ZZ").upper().strip()
            self.app.database.ingest(payload, self.client_ip(), country)
        except (ValueError, json.JSONDecodeError) as error:
            self.json_response(HTTPStatus.BAD_REQUEST, {"message": str(error)})
            return
        self.json_response(HTTPStatus.ACCEPTED, {"accepted": True})

    def handle_login(self) -> None:
        client_ip = self.client_ip()
        if not self.app.login_limiter.allowed(client_ip):
            self.respond(HTTPStatus.TOO_MANY_REQUESTS, "请稍后重试".encode(), "text/plain; charset=utf-8")
            return
        try:
            values = urllib.parse.parse_qs(self.read_body().decode())
        except (ValueError, UnicodeDecodeError):
            self.redirect("/login?error=1")
            return
        username = values.get("username", [""])[0]
        password = values.get("password", [""])[0]
        valid = hmac.compare_digest(username, self.app.config.admin_username) and verify_password(
            password, self.app.config.admin_password_hash
        )
        if not valid:
            self.app.login_limiter.failed(client_ip)
            time.sleep(0.4)
            self.redirect("/login?error=1")
            return
        issued = int(time.time())
        nonce = secrets.token_hex(16)
        signed = f"{issued}.{nonce}"
        signature = hmac.new(self.app.config.session_secret, signed.encode(), hashlib.sha256).hexdigest()
        secure = "; Secure" if self.app.config.secure_cookie else ""
        self.send_response(HTTPStatus.SEE_OTHER)
        self.send_header("Location", "/admin")
        self.send_header(
            "Set-Cookie",
            f"call_admin_session={signed}.{signature}; Path=/; Max-Age={SESSION_SECONDS}; HttpOnly{secure}; SameSite=Strict",
        )
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", "0")
        self.end_headers()


class TelemetryServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, config: Config) -> None:
        self.config = config
        self.database = TelemetryDatabase(config.database_path, config.identifier_secret, config.retention_days)
        self.login_limiter = LoginLimiter()
        super().__init__((config.bind_host, config.bind_port), TelemetryHandler)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--hash-password", metavar="PASSWORD")
    args = parser.parse_args()
    if args.hash_password is not None:
        print(encode_password(args.hash_password))
        return
    config = Config.from_environment()
    server = TelemetryServer(config)
    print(f"Telemetry service listening on {config.bind_host}:{config.bind_port}", flush=True)
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
