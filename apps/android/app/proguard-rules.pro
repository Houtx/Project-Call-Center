-keepattributes Signature
-keepattributes *Annotation*
-keep class com.company.callcenter.data.remote.** { *; }

# Gson reads these payloads through reflection in the minified release APK.
# Keep fields (including constant appVersion) and their SerializedName annotations.
-keep class com.company.callcenter.telemetry.UsageTelemetryPayload { *; }
-keep class com.company.callcenter.telemetry.UsageTelemetryDailyMetric { *; }
-keep class com.company.callcenter.telemetry.UsageTelemetryDailyLocation { *; }
