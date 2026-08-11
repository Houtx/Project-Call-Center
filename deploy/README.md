# Shared-host production runbook

> This repository contains no production-host inventory or deployment record. Do not run the commands in this document until the capacity and security gates in [`../OPERATIONS_GUIDE.md`](../OPERATIONS_GUIDE.md) have been independently verified for your target host.

Do not execute deployment steps until a read-only inventory has recorded the target host's ports, containers, processes, Nginx virtual hosts, certificates, disk usage, memory pressure and service health. Store that inventory outside the public repository.

## Isolation contract

- Use `/opt/project-call-center` as the only application directory.
- Use the Compose project name `project-call-center`, a dedicated network and dedicated named volumes.
- Bind the API only to a confirmed-free loopback port; expose only the new HTTPS virtual host through Nginx.
- Use a new database/database user and never reuse another project's volume, credentials, service name or Nginx file.
- Store encrypted backups off-host. A backup on the same server is not a disaster-recovery copy.
- Build and test immutable artifacts before uploading them to production.

## Change procedure

1. Capture the read-only baseline and verify all existing host routes.
2. Back up the call-center database if this is an upgrade.
3. Start or update only the `project-call-center` Compose project.
4. Verify the API health endpoint through loopback before changing Nginx.
5. Install a dedicated virtual-host file, run `nginx -t`, then reload Nginx without stopping it.
6. Verify the new web/API routes and every previously recorded existing route.
7. Verify database migrations, application health, worker backlog and Android bootstrap response.

Rollback changes only this project's containers and virtual host. Never restart or recreate unrelated containers as part of the rollback.

## Artifacts

- `compose.production.yaml`: isolated API, Worker, PostgreSQL volume and Web containers.
- `.env.production.example`: non-secret environment template. The real `.env.production` is ignored by Git.
- `nginx-call-center.conf.example`: dedicated loopback reverse proxy virtual host.
- `backup-postgres.sh`: client-side `age` encryption followed by off-host S3-compatible upload.

The application does not retain the original plaintext import file. Parsed rows are encrypted or masked in PostgreSQL. S3-compatible storage is used for encrypted off-host database backups; exports are generated on demand and audited.

## Read-only preflight

Run equivalent read-only commands appropriate for the host and save the output outside the application directory:

```bash
date -Is
df -h
free -h
ss -lntup
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}'
docker network ls
docker volume ls
nginx -T
systemctl --type=service --state=running
```

Record every existing public Host route and verify it before any change. Confirm that loopback ports `18800` and `18801` are free; choose different explicit values in `.env.production` when they are occupied.

## Build and configuration

Build immutable images in CI or on an isolated build machine. Tag both images with the same release version and digest. On the target host, create only `/opt/project-call-center`, then place the Compose file and a private `.env.production` there.

When the build machine and target host use different CPU architectures, build and verify the target image platform explicitly; never transfer an unchecked local image or build the application on a memory-constrained production host. Before production, add tested CPU, memory, PID and log-rotation limits to the Compose services and add a business-level freshness signal for the Worker.

Generate secrets independently:

```bash
openssl rand -hex 32
openssl rand -base64 32
openssl rand -base64 32
openssl rand -base64 36
```

The two phone keys are long-lived data keys. Back them up in the company secret store; losing `PHONE_ENCRYPTION_KEY` makes existing numbers unrecoverable, while changing `PHONE_HASH_KEY` breaks number lookup and duplicate detection.

Validate configuration without starting containers:

```bash
docker compose --env-file deploy/.env.production -f deploy/compose.production.yaml config --quiet
docker compose --env-file deploy/.env.production -f deploy/compose.production.yaml pull
```

## First start or upgrade

Before an upgrade, complete and verify an off-host encrypted backup. Then start only this Compose project:

```bash
docker compose --env-file deploy/.env.production -f deploy/compose.production.yaml up -d postgres
docker compose --env-file deploy/.env.production -f deploy/compose.production.yaml run --rm migrate
docker compose --env-file deploy/.env.production -f deploy/compose.production.yaml run --rm bootstrap-admin
docker compose --env-file deploy/.env.production -f deploy/compose.production.yaml up -d api worker web
docker compose --env-file deploy/.env.production -f deploy/compose.production.yaml ps
curl --fail --silent http://127.0.0.1:18800/api/v1/health
curl --fail --silent http://127.0.0.1:18801/healthz
```

`bootstrap-admin` creates only the first administrator and never resets an existing password. Remove `ADMIN_INITIAL_PASSWORD` from `.env.production` immediately after the first successful run. Do not run the development seed command in production because it intentionally creates demonstration data.

Copy the dedicated Nginx virtual host only after loopback checks pass. Replace `call.example.com`, run `nginx -t`, reload Nginx, then obtain/configure the HTTPS certificate. Never restart Nginx for this project.

```bash
nginx -t
systemctl reload nginx
curl --fail --silent https://call.example.com/api/v1/health
```

Recheck every preflight Host route after the reload. Verify an admin login, dashboard, one test assignment, mobile bootstrap, Worker logs and the report refresh time before opening access to agents.

## Backup and restore drill

The backup host requires Docker Compose, `age`, AWS CLI and `sha256sum`. The age private key must not be stored on the application host.

```bash
BACKUP_AGE_RECIPIENT='age1...' \
S3_BACKUP_URI='s3://company-backups/project-call-center' \
S3_ENDPOINT_URL='https://s3.example.com' \
deploy/backup-postgres.sh
```

Schedule this daily from a restricted service account. Monitor both the job exit code and object existence. Retention rules belong to the remote bucket, not the application server.

For a restore drill, download one `.dump.age` and checksum to an isolated recovery machine, verify SHA-256, decrypt with the age identity, and restore into a new empty PostgreSQL database:

```bash
age --decrypt --identity /secure/backup-identity.txt --output recovery.dump project-call-center-TIMESTAMP.dump.age
createdb call_center_recovery
pg_restore --exit-on-error --no-owner --no-acl --dbname call_center_recovery recovery.dump
```

Run row-count checks, admin authentication, report queries and a sampled phone decryption check using a secured copy of the production phone keys. Record the drill time and result in the recovery audit log.

## Rollback

Keep the previous immutable API/Web image tags. To roll back application code, change only `API_IMAGE` and `WEB_IMAGE`, then recreate `api`, `worker` and `web`. Database migrations must be reviewed before release; never run an automatic destructive down-migration.

```bash
docker compose --env-file deploy/.env.production -f deploy/compose.production.yaml up -d --no-deps api worker web
```

If the new Nginx virtual host is the failure source, restore only its previous file, run `nginx -t`, reload, and recheck all Host routes. Do not use `docker compose down` during a routine rollback because PostgreSQL and unrelated availability should remain stable.
