#!/usr/bin/env bash
set -euo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-deploy/compose.production.yaml}"
ENV_FILE="${ENV_FILE:-deploy/.env.production}"
BACKUP_AGE_RECIPIENT="${BACKUP_AGE_RECIPIENT:?set BACKUP_AGE_RECIPIENT}"
S3_BACKUP_URI="${S3_BACKUP_URI:?set S3_BACKUP_URI, for example s3://company-backups/project-call-center}"
S3_ENDPOINT_URL="${S3_ENDPOINT_URL:-}"

for command_name in docker age aws sha256sum; do
  command -v "$command_name" >/dev/null || {
    echo "Missing required command: $command_name" >&2
    exit 1
  }
done

backup_timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_name="project-call-center-${backup_timestamp}.dump.age"
backup_tmp="$(mktemp -d)"
encrypted_path="${backup_tmp}/${backup_name}"
checksum_path="${encrypted_path}.sha256"
trap 'rm -rf -- "$backup_tmp"' EXIT

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T postgres \
  sh -c 'exec pg_dump --format=custom --compress=6 --no-owner --no-acl --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"' \
  | age --recipient "$BACKUP_AGE_RECIPIENT" --output "$encrypted_path"

sha256sum "$encrypted_path" | sed "s#${encrypted_path}#${backup_name}#" > "$checksum_path"

aws_args=(s3 cp --only-show-errors)
if [[ -n "$S3_ENDPOINT_URL" ]]; then
  aws_args+=(--endpoint-url "$S3_ENDPOINT_URL")
fi
aws "${aws_args[@]}" "$encrypted_path" "${S3_BACKUP_URI%/}/${backup_name}"
aws "${aws_args[@]}" "$checksum_path" "${S3_BACKUP_URI%/}/${backup_name}.sha256"

echo "Uploaded encrypted backup: ${S3_BACKUP_URI%/}/${backup_name}"
