# Architecture

Project Call Center is a single-company SIM calling CRM with two user surfaces:

- Administrators use the React web application to maintain customers, allocate work, manage agents and inspect call statistics.
- Agents use the Android application to synchronize assigned customers and start calls through the system dialer, either one at a time or through an explicitly enabled, visible, cancellable auto-dial countdown.

## Trust boundaries

In online mode, the API is the source of truth for customer ownership, suppression, retry limits and report definitions. The Android app requests a short-lived dial authorization immediately before every online call.

Independent mode has a separate trust boundary. It never logs in to or synchronizes with the CRM API. Imported contacts, queue state and call history live in a dedicated Room database and cannot be copied into the online cache. Phone numbers and optional names are encrypted with an Android Keystore-backed AES-GCM key, while a separate device-local HMAC supports deduplication. A PBKDF2 verifier gates the local UI; backgrounding the app starts a one-hour inactivity lock, and returning to the app checks the persisted background timestamp before allowing access. The system dialer and system CallLog remain outside this encrypted boundary.

Independent-mode task queries execute their state/date predicates and counts in Room and return at most 100 contacts. Queue-order invalidation refills that window after a call without decrypting the complete contact database. Import operations create a durable batch record and tag only newly inserted contacts; batch deletion, call authorization and call settlement are serialized, and deletion is rejected while a matching call is pending. Database migration `1 -> 2` preserves existing untagged contacts and adds the batch tables and task indices without destructive fallback.

The Android system CallLog is an operational observation, not carrier-grade evidence. Only CallLog rows matched to an API-created call attempt may be uploaded. Personal calls and contacts are outside the data boundary.

## Runtime components

| Component | Responsibility |
| --- | --- |
| Admin web | Customer, batch, allocation, agent, device, suppression, call and audit workflows |
| API | Authentication, authorization, business invariants, encrypted phone storage, reporting and default background jobs |
| Optional Worker | Runs reconciliation separately only when the `dedicated-worker` production profile is enabled |
| PostgreSQL | Transactional source of truth and audit history |
| Android app | Online synchronization; isolated independent-mode storage/imports; SIM dial handoff; local outbox and CallLog matching |
| S3-compatible storage | Client-side encrypted off-host database backups in production |

All timestamps are stored as UTC and rendered in `Asia/Shanghai`. Phone numbers are normalized to E.164, encrypted with AES-256-GCM and indexed only by keyed HMAC. Full-number access is always an audited operation.

Customer creation and imports use the bundled offline `phone2region` prefix database to fill missing province, city and carrier values before encryption and preview. Explicit administrator input takes precedence, lookup failures do not block valid numbers, and carrier attribution is operational metadata only because number portability and newly allocated ranges can make prefix data stale.

Compliance erasure is allowed only after a customer is archived and active assignments are withdrawn. It replaces personal fields and the encrypted phone identity while retaining anonymized assignment/call aggregates and an audit event containing the stated deletion reason.

## Android startup boundaries

The release APK does not embed a business server. A user configures an HTTPS domain on the login screen; the app normalizes it to `/api/v1/`, verifies the health endpoint and stores only the validated endpoint. A change to a different server clears the old authentication, device binding and local business cache. Pending CallLog observations block a server change so that an attempt cannot silently move between server identities.

Before any business screen runs on a cold process start, the app checks the configured HTTPS Release manifest. Normal foreground resumes and returns from the system dialer do not repeat this check. A newer `versionCode` keeps the app locked until the APK has been downloaded, checked for size, SHA-256, package name, version and signing certificate, and installed through the Android system installer. Android does not allow this application to install updates silently. Update-source network failures, invalid metadata and integrity failures all fail closed and require a retry or a manually distributed APK.

The server has a second compatibility boundary: exact manufacturer/model/API allowlisting and `minimumVersionCode`. Administrators can disable the allowlist check with `deviceCompatibilityRequired` when a controlled rollout needs to accept any Android 8.0+ device; app version, active-device, online and call-permission checks remain enforced. When `forceUpgrade` is enabled, clients below `latestVersionCode` are rejected while the latest version remains usable.

An agent login includes the app installation ID and device metadata. The API serializes logins for that agent, revokes all previous refresh tokens and active devices, increments the JWT session version, then makes the current phone the only active device. It also emits a fresh sync snapshot for every active assignment, so a replacement phone does not depend on old sync-history rows. Old access tokens fail on their next request, and the foreground app checks its session at least every 15 seconds. Administrators may still revoke the current device manually. A phone with an uncollected CallLog observation should finish uploading before another phone replaces its session.

## Call state model

1. `POST /api/v1/mobile/call-attempts` validates the active assignment, device health, suppression list, retry count and retry interval.
2. The API creates a durable attempt before returning the short-lived dial number.
3. Android records a CallLog baseline and launches the system dialer.
4. Android matches only a newer outgoing row for the same normalized phone number and uploads the observation idempotently.
5. A duration above zero becomes `CONNECTED`; zero becomes `NOT_CONNECTED`; no observation after 24 hours becomes `UNKNOWN`.
6. `CONNECTED` or reaching the administrator-configured attempt limit closes the assignment. The limit defaults to two and may be set from 1-10. A zero-duration result retains the task for another call after 30 minutes and moves it behind all uncalled tasks in the Android queue.

Unknown calls remain visible in the attempt count and data-completeness metric but are excluded from the connection-rate denominator.

Independent mode applies the same `duration > 0`, zero-duration and 24-hour unknown definitions locally. It permits one pending attempt at a time, moves a non-connected contact to the end of the queue and defaults to two attempts. The user may change the local limit from 1-10; existing retry/exhausted states are reconciled to the new limit.

Independent-mode imports support bounded XLSX, XLSM, CSV, TSV and explicit paste input. The user selects only a worksheet and phone column; the first 20 raw rows are classified before import, and normalized values are accepted by 11-digit length rather than carrier-prefix rules. Spreadsheet files are copied only to the app-private cache while a preview session is active, capped by file/ZIP/XML/row/column/cell limits and deleted on completion, failure, lock, mode change or next process initialization. Macros are never executed; encrypted and legacy OLE workbooks are rejected.

Optional usage telemetry is compile-time disabled unless an HTTPS endpoint is configured. Configured builds enable it by default at runtime, retain an explicit opt-out across upgrades and endpoint changes, and never block calling. It sends at most one small aggregate per UTC day using a random telemetry identifier that is unrelated to online device/session identifiers. A separate local SQLite store deduplicates settled attempts by event hash and queues no more than 31 dirty daily aggregates. Payloads exclude phone numbers, names, SIM data, server addresses, filenames, customer IDs and call-level timestamps.

Original plaintext import files are parsed in memory and are not retained. Import row metadata and phone values are stored in PostgreSQL using the same encryption and masking boundary as customer data, then terminal row details are removed after the configured technical retention period. CSV exports are generated as bounded database pages and streamed to the administrator; starting an export creates an audit event before any CSV bytes are sent.

The current import implementation is synchronous and has a hard ceiling of 100,000 rows; the low-resource production profile defaults to 10,000. CSV parsing and the XLSX streaming preflight stop when that configured row ceiling is exceeded, while accepted XLSX rows are still parsed and staged in API memory after preflight. It is a documented production capacity constraint, not an asynchronous Worker job. See `KNOWN_ISSUES.md` before sizing a host.
