# Android Device Allowlist

Production calling is disabled unless the exact manufacturer, model and Android API level are enabled in the server allowlist. The application supports Android 12 (API 31) and newer.

## Entry criteria

Run at least 20 controlled app-initiated calls on every candidate device/OS combination. Include connected calls of different durations, zero-duration calls, cancellation before dialing and repeated calls to the same number.

The model can be enabled only when:

- `CALL_PHONE`, `READ_CALL_LOG` and `READ_PHONE_STATE` can be granted through the approved internal installation channel.
- Every API-created attempt is visible as pending, connected, not connected or unknown; no attempt silently disappears.
- Every available CallLog row is matched to the correct attempt within five minutes.
- Calls started outside the application are never uploaded.
- Permission revocation blocks new app calls before a dial authorization is issued.

## Required resilience scenarios

- Network loss after the call and recovery through the local outbox.
- Application process termination during a system call.
- Device restart while an observation is pending.
- Delayed CallLog insertion and a late result within 24 hours.
- Clock offset greater than five minutes.
- SIM replacement, system dialer changes and power-saving restrictions.
- Single-SIM calls with the card in each physical slot, plus dual-SIM fixed-slot and alternating calls.
- Removing or disabling one card after selecting the other card or alternating mode; the remaining card must be used automatically.
- Upgrade from the previous signed APK without losing pending observations.
- Startup with an unavailable or invalid update manifest; the business UI must remain locked and retry must recover.
- Required update download, unknown-source authorization, system installer cancellation and successful in-place upgrade.
- First-time HTTPS server configuration, malformed address, invalid certificate and unavailable health endpoint.
- Switching to another healthy server after all observations are synchronized; old tokens, binding and cached tasks must not survive.
- Attempting to switch servers while an observation is pending; the app must keep the old context and explain how to recover.
- Logging the same agent into a second phone; the first phone must return to login within 15 seconds or on its next API operation, and its refresh token must be rejected.
- Replacing a phone only after pending CallLog observations are synchronized; document the expected `UNKNOWN` result if an active session is intentionally replaced during collection.

The pilot gate is at least seven days with 5-10 agents, at least 99% of observations collected within five minutes, and an unknown rate below 1%. A failing device/OS combination must be disabled rather than silently tolerated.

Record the APK `versionCode`, signing-certificate SHA-256, manufacturer, exact model, Android API, system build number, default dialer and test date for every result. Approval applies only to that recorded combination.
