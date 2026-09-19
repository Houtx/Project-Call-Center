import dalvik.system.DexClassLoader;
import java.lang.reflect.Method;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.Collections;
import java.util.List;
import org.json.JSONObject;

/** Run against an actual minified APK using Android app_process; never sends data. */
public final class ReleaseTelemetrySmoke {
    public static void main(String[] args) throws Exception {
        ClassLoader loader = new DexClassLoader(args[0], args[1], null,
                ReleaseTelemetrySmoke.class.getClassLoader());
        String prefix = "com.company.callcenter.telemetry.";
        String today = LocalDate.now(ZoneOffset.UTC).toString();
        Object metric = loader.loadClass(prefix + "UsageTelemetryDailyMetric")
                .getConstructor(String.class, String.class, int.class, int.class, int.class, int.class, long.class)
                .newInstance(today, "offline", 4, 2, 1, 1, 180L);
        Object location = loader.loadClass(prefix + "UsageTelemetryDailyLocation")
                .getConstructor(String.class, long.class, long.class, float.class, String.class)
                .newInstance(today, 312304160L, 1214737010L, 32.5f, Instant.now().toString());
        Object payload = loader.loadClass(prefix + "UsageTelemetryPayload")
                .getConstructor(String.class, String.class, String.class, int.class, String.class,
                        String.class, String.class, List.class, List.class)
                .newInstance("8d21d0ef-23ae-4df0-a090-6b7d44d4a111", today, "0.7.5", 35,
                        "offline", "zh-CN", "Asia/Shanghai", Collections.singletonList(metric),
                        Collections.singletonList(location));
        Class<?> gsonClass = loader.loadClass(args[2]);
        Object gson = gsonClass.getConstructor().newInstance();
        // R8 may specialize Object to the sole payload type used by the app.
        Method serialize;
        try {
            serialize = gsonClass.getDeclaredMethod(args[3], Object.class);
        } catch (NoSuchMethodException specialized) {
            serialize = gsonClass.getDeclaredMethod(args[3], payload.getClass());
        }
        serialize.setAccessible(true);
        String json = (String) serialize.invoke(gson, payload);
        JSONObject value = new JSONObject(json);
        if (value.length() != 9 || !value.getString("appVersion").equals("0.7.5") ||
                value.getJSONArray("dailyMetrics").getJSONObject(0).getInt("callCount") != 4 ||
                value.getJSONArray("locations").getJSONObject(0).getLong("latitudeE7") != 312304160L)
            throw new AssertionError("Release serialization mismatch");
        System.out.println(json);
    }
}
