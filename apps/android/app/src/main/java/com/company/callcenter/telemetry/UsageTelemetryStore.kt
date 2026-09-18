package com.company.callcenter.telemetry

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import com.company.callcenter.data.AppMode
import com.google.gson.annotations.SerializedName
import java.security.MessageDigest
import java.time.Instant
import java.time.ZoneId

internal data class UsageTelemetryDailyMetric(
    @SerializedName("date") val date: String,
    @SerializedName("mode") val mode: String,
    @SerializedName("callCount") val callCount: Int,
    @SerializedName("connectedCount") val connectedCount: Int,
    @SerializedName("notConnectedCount") val notConnectedCount: Int,
    @SerializedName("unknownCount") val unknownCount: Int,
    @SerializedName("totalDurationSeconds") val totalDurationSeconds: Long,
)

internal data class UsageTelemetryMetricSnapshot(
    val payload: UsageTelemetryDailyMetric,
    val revision: Long,
)

internal data class UsageTelemetryDailyLocation(
    @SerializedName("date") val date: String,
    @SerializedName("latitudeE7") val latitudeE7: Long,
    @SerializedName("longitudeE7") val longitudeE7: Long,
    @SerializedName("accuracyMeters") val accuracyMeters: Float,
    @SerializedName("capturedAt") val capturedAt: String,
)

internal data class UsageTelemetryLocationSnapshot(
    val payload: UsageTelemetryDailyLocation,
    val revision: Long,
)

internal class UsageTelemetryStore(context: Context) :
    SQLiteOpenHelper(context.applicationContext, DATABASE_NAME, null, DATABASE_VERSION) {

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """
            CREATE TABLE daily_metrics (
              metric_date TEXT NOT NULL,
              mode TEXT NOT NULL,
              call_count INTEGER NOT NULL,
              connected_count INTEGER NOT NULL,
              not_connected_count INTEGER NOT NULL,
              unknown_count INTEGER NOT NULL,
              total_duration_seconds INTEGER NOT NULL,
              revision INTEGER NOT NULL,
              uploaded_revision INTEGER NOT NULL DEFAULT 0,
              PRIMARY KEY (metric_date, mode)
            )
            """.trimIndent(),
        )
        db.execSQL(
            """
            CREATE TABLE counted_events (
              event_hash TEXT PRIMARY KEY,
              recorded_at INTEGER NOT NULL
            )
            """.trimIndent(),
        )
        db.execSQL("CREATE INDEX counted_events_recorded_at ON counted_events(recorded_at)")
        createLocationTable(db)
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        if (oldVersion < 2) createLocationTable(db)
    }

    @Synchronized
    fun recordCall(
        eventId: String,
        mode: AppMode,
        result: String,
        durationSeconds: Int?,
        startedAtMillis: Long,
    ) {
        if (eventId.isBlank() || result !in RESULTS) return
        val recordedAt = System.currentTimeMillis()
        val metricDate = Instant.ofEpochMilli(startedAtMillis)
            .atZone(ZoneId.systemDefault())
            .toLocalDate()
            .toString()
        writableDatabase.beginTransaction()
        try {
            val inserted = writableDatabase.compileStatement(
                "INSERT OR IGNORE INTO counted_events(event_hash, recorded_at) VALUES (?, ?)",
            ).apply {
                bindString(1, eventHash(eventId))
                bindLong(2, recordedAt)
            }.executeInsert()
            if (inserted == -1L) return
            writableDatabase.execSQL(
                """
                INSERT INTO daily_metrics (
                  metric_date, mode, call_count, connected_count, not_connected_count,
                  unknown_count, total_duration_seconds, revision, uploaded_revision
                ) VALUES (?, ?, 1, ?, ?, ?, ?, 1, 0)
                ON CONFLICT(metric_date, mode) DO UPDATE SET
                  call_count=call_count + 1,
                  connected_count=connected_count + excluded.connected_count,
                  not_connected_count=not_connected_count + excluded.not_connected_count,
                  unknown_count=unknown_count + excluded.unknown_count,
                  total_duration_seconds=total_duration_seconds + excluded.total_duration_seconds,
                  revision=revision + 1
                """.trimIndent(),
                arrayOf(
                    metricDate,
                    mode.name.lowercase(),
                    if (result == "CONNECTED") 1 else 0,
                    if (result == "NOT_CONNECTED") 1 else 0,
                    if (result == "UNKNOWN") 1 else 0,
                    if (result == "CONNECTED") durationSeconds?.coerceAtLeast(0) ?: 0 else 0,
                ),
            )
            writableDatabase.delete(
                "counted_events",
                "recorded_at < ?",
                arrayOf((recordedAt - EVENT_RETENTION_MILLIS).toString()),
            )
            writableDatabase.setTransactionSuccessful()
        } finally {
            writableDatabase.endTransaction()
        }
    }

    @Synchronized
    fun pendingMetrics(): List<UsageTelemetryMetricSnapshot> {
        val rows = readableDatabase.query(
            "daily_metrics",
            arrayOf(
                "metric_date",
                "mode",
                "call_count",
                "connected_count",
                "not_connected_count",
                "unknown_count",
                "total_duration_seconds",
                "revision",
            ),
            "revision > uploaded_revision",
            null,
            null,
            null,
            "metric_date ASC",
            MAX_PENDING_DAYS.toString(),
        )
        return rows.use {
            buildList {
                while (it.moveToNext()) {
                    add(
                        UsageTelemetryMetricSnapshot(
                            payload = UsageTelemetryDailyMetric(
                                date = it.getString(0),
                                mode = it.getString(1),
                                callCount = it.getInt(2),
                                connectedCount = it.getInt(3),
                                notConnectedCount = it.getInt(4),
                                unknownCount = it.getInt(5),
                                totalDurationSeconds = it.getLong(6),
                            ),
                            revision = it.getLong(7),
                        ),
                    )
                }
            }
        }
    }

    @Synchronized
    fun markUploaded(snapshots: List<UsageTelemetryMetricSnapshot>) {
        if (snapshots.isEmpty()) return
        writableDatabase.beginTransaction()
        try {
            snapshots.forEach { snapshot ->
                writableDatabase.execSQL(
                    """
                    UPDATE daily_metrics SET uploaded_revision = ?
                    WHERE metric_date = ? AND mode = ? AND revision = ?
                    """.trimIndent(),
                    arrayOf(
                        snapshot.revision,
                        snapshot.payload.date,
                        snapshot.payload.mode,
                        snapshot.revision,
                    ),
                )
            }
            writableDatabase.setTransactionSuccessful()
        } finally {
            writableDatabase.endTransaction()
        }
    }

    @Synchronized
    fun hasLocation(date: String): Boolean = readableDatabase.query(
        "daily_locations",
        arrayOf("location_date"),
        "location_date = ?",
        arrayOf(date),
        null,
        null,
        null,
        "1",
    ).use { it.moveToFirst() }

    @Synchronized
    fun recordLocation(location: UsageTelemetryDailyLocation) {
        writableDatabase.execSQL(
            """
            INSERT INTO daily_locations (
              location_date, latitude_e7, longitude_e7, accuracy_meters,
              captured_at, revision, uploaded_revision
            ) VALUES (?, ?, ?, ?, ?, 1, 0)
            ON CONFLICT(location_date) DO UPDATE SET
              latitude_e7=excluded.latitude_e7,
              longitude_e7=excluded.longitude_e7,
              accuracy_meters=excluded.accuracy_meters,
              captured_at=excluded.captured_at,
              revision=revision + 1
            """.trimIndent(),
            arrayOf(
                location.date,
                location.latitudeE7,
                location.longitudeE7,
                location.accuracyMeters,
                location.capturedAt,
            ),
        )
    }

    @Synchronized
    fun pendingLocations(): List<UsageTelemetryLocationSnapshot> {
        val rows = readableDatabase.query(
            "daily_locations",
            arrayOf(
                "location_date",
                "latitude_e7",
                "longitude_e7",
                "accuracy_meters",
                "captured_at",
                "revision",
            ),
            "revision > uploaded_revision",
            null,
            null,
            null,
            "location_date ASC",
            MAX_PENDING_DAYS.toString(),
        )
        return rows.use {
            buildList {
                while (it.moveToNext()) {
                    add(
                        UsageTelemetryLocationSnapshot(
                            payload = UsageTelemetryDailyLocation(
                                date = it.getString(0),
                                latitudeE7 = it.getLong(1),
                                longitudeE7 = it.getLong(2),
                                accuracyMeters = it.getFloat(3),
                                capturedAt = it.getString(4),
                            ),
                            revision = it.getLong(5),
                        ),
                    )
                }
            }
        }
    }

    @Synchronized
    fun markLocationsUploaded(snapshots: List<UsageTelemetryLocationSnapshot>) {
        if (snapshots.isEmpty()) return
        writableDatabase.beginTransaction()
        try {
            snapshots.forEach { snapshot ->
                writableDatabase.execSQL(
                    """
                    UPDATE daily_locations SET uploaded_revision = ?
                    WHERE location_date = ? AND revision = ?
                    """.trimIndent(),
                    arrayOf(snapshot.revision, snapshot.payload.date, snapshot.revision),
                )
            }
            writableDatabase.setTransactionSuccessful()
        } finally {
            writableDatabase.endTransaction()
        }
    }

    private fun createLocationTable(db: SQLiteDatabase) {
        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS daily_locations (
              location_date TEXT PRIMARY KEY,
              latitude_e7 INTEGER NOT NULL,
              longitude_e7 INTEGER NOT NULL,
              accuracy_meters REAL NOT NULL,
              captured_at TEXT NOT NULL,
              revision INTEGER NOT NULL,
              uploaded_revision INTEGER NOT NULL DEFAULT 0
            )
            """.trimIndent(),
        )
    }

    private fun eventHash(value: String): String = MessageDigest.getInstance("SHA-256")
        .digest(value.toByteArray())
        .joinToString("") { "%02x".format(it) }

    private companion object {
        const val DATABASE_NAME = "usage-telemetry.db"
        const val DATABASE_VERSION = 2
        const val MAX_PENDING_DAYS = 31
        const val EVENT_RETENTION_MILLIS = 45L * 24 * 60 * 60 * 1000
        val RESULTS = setOf("CONNECTED", "NOT_CONNECTED", "UNKNOWN")
    }
}
