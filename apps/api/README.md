# Call Center API

NestJS modular monolith for the administrator web app and the Android SIM-calling app. PostgreSQL is the source of truth; phone numbers are normalized to E.164, encrypted with AES-256-GCM, and indexed by keyed HMAC only.

Repository-level setup, operations and known constraints are documented in [`../../DEVELOPMENT_GUIDE.md`](../../DEVELOPMENT_GUIDE.md), [`../../OPERATIONS_GUIDE.md`](../../OPERATIONS_GUIDE.md) and [`../../KNOWN_ISSUES.md`](../../KNOWN_ISSUES.md).

## Local setup

From the repository root:

```bash
cp apps/api/.env.example apps/api/.env
docker compose up -d postgres
npm run db:generate
npm run db:migrate
npm run db:seed
npm run dev:api
```

The API is served at `http://localhost:8800/api/v1`, health at `/api/v1/health`, and development Swagger UI at `/api/docs`.

Run the timeout worker separately:

```bash
npm run start:worker --workspace @call-center/api
```

## Main routes

- `POST /auth/login`, `/auth/refresh`, `/auth/logout`
- `GET|POST|PATCH /customers`, `GET|POST|PATCH /batches`
- `POST /customers/import/preview`, `/customers/import/commit`, `GET /customers/export`
- `POST /assignments`, `/assignments/retry`, `/assignments/withdraw`, `/assignments/reassign`
- `GET|POST|DELETE /suppression`
- `GET|POST|PATCH /agents`, `GET /devices`, `POST /devices/:id/revoke`
- `POST /agents/:id/reset-password`, `GET|POST|PATCH /device-models`, `GET|PATCH /mobile-app-policy`
- `GET /dashboard/stats`, `/reports/summary`, `/calls`, `/calls/export`, `/audit-events`
- `GET /mobile/bootstrap`, `/mobile/sync`
- `POST /mobile/assignments/:id/phone`, `/mobile/call-attempts`, `/mobile/call-attempts/:id/unobserved`, `/mobile/call-log-results:batch`, `/mobile/heartbeat`

Commands use `Idempotency-Key` where the response can be safely replayed. Mobile login atomically registers the submitted device and invalidates the agent's previous device session; call attempts and observations use `clientAttemptId` and `eventId` as domain idempotency keys. Full phone values and authentication tokens are never persisted in idempotency responses or logs.

## Operational invariants

- One active assignment per customer and one active device per agent are enforced by PostgreSQL partial unique indexes.
- `assignmentStatus=NOT_CONNECTED` selects only customers whose latest assignment's latest call is `NOT_CONNECTED`; retry assignment preserves history and starts a fresh assignment attempt budget.
- Suppression is checked at import, assignment, reveal, and dial authorization; adding a number immediately closes active assignments and emits sync tombstones.
- The administrator-configured `maxCallAttempts` policy allows 1-10 attempts per assignment and defaults to two, with at least 30 minutes between attempts.
- CallLog duration greater than zero is `CONNECTED`; zero is `NOT_CONNECTED`; the worker marks missing observations `UNKNOWN` after 24 hours for normal Android routing. System-managed dialers (for example 卓易通 compatibility mode) use a two-minute fallback window and the APP settles an unobservable return as `UNKNOWN` so one missing CallLog row cannot block the queue.
- `UNKNOWN` and collecting calls do not enter the connection-rate denominator. Late CallLog observations replace timeout results and update reports.
- `minimumVersionCode` rejects older mobile clients. When `forceUpgrade` is enabled, clients below `latestVersionCode` are rejected while the latest version remains usable.
- Mobile sync always returns `maxCallAttempts`, so Android displays and enforces the same current policy as the API.

Before production, replace all example secrets, run migrations, seed only with explicit production passwords, run the API and worker as separate processes, and configure encrypted off-host PostgreSQL backups.
