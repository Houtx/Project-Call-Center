-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'AGENT');
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'DISABLED');
CREATE TYPE "BatchStatus" AS ENUM ('ACTIVE', 'ARCHIVED');
CREATE TYPE "CustomerStatus" AS ENUM ('AVAILABLE', 'ASSIGNED', 'COMPLETED', 'ARCHIVED', 'SUPPRESSED');
CREATE TYPE "AssignmentStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'RECLAIMED', 'REASSIGNED', 'SUPPRESSED');
CREATE TYPE "DeviceStatus" AS ENUM ('ACTIVE', 'REVOKED', 'PENDING');
CREATE TYPE "ActivationStatus" AS ENUM ('PENDING', 'USED', 'EXPIRED', 'REVOKED');
CREATE TYPE "PermissionState" AS ENUM ('UNKNOWN', 'GRANTED', 'DENIED');
CREATE TYPE "AttemptStatus" AS ENUM ('PENDING', 'COLLECTING', 'CONNECTED', 'NOT_CONNECTED', 'UNKNOWN');
CREATE TYPE "CallResultSource" AS ENUM ('CALL_LOG', 'TIMEOUT');
CREATE TYPE "SuppressionSource" AS ENUM ('MANUAL', 'IMPORT', 'COMPLIANCE');
CREATE TYPE "ImportMode" AS ENUM ('SKIP_DUPLICATES', 'UPDATE_EXISTING');
CREATE TYPE "ImportJobStatus" AS ENUM ('UPLOADED', 'PREVIEWED', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED');
CREATE TYPE "ImportRowStatus" AS ENUM ('NEW', 'UPDATE', 'DUPLICATE', 'INVALID', 'SUPPRESSED', 'IMPORTED', 'FAILED');
CREATE TYPE "SyncEntityType" AS ENUM ('ASSIGNMENT', 'CUSTOMER', 'CALL_ATTEMPT', 'DEVICE');
CREATE TYPE "SyncOperation" AS ENUM ('UPSERT', 'REMOVE');
CREATE TYPE "IdempotencyStatus" AS ENUM ('PROCESSING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "username" VARCHAR(80) NOT NULL,
    "displayName" VARCHAR(120) NOT NULL,
    "passwordHash" VARCHAR(255) NOT NULL,
    "role" "Role" NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "tokenVersion" INTEGER NOT NULL DEFAULT 0,
    "lastLoginAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "deviceId" UUID,
    "tokenHash" VARCHAR(64) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "lastUsedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "batches" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "description" TEXT,
    "status" "BatchStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdById" UUID,
    "archivedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "batches_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "customers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "batchId" UUID,
    "createdById" UUID,
    "name" VARCHAR(160),
    "phoneCiphertext" BYTEA NOT NULL,
    "phoneIv" BYTEA NOT NULL,
    "phoneTag" BYTEA NOT NULL,
    "phoneHash" VARCHAR(64) NOT NULL,
    "phoneMasked" VARCHAR(32) NOT NULL,
    "province" VARCHAR(80),
    "city" VARCHAR(80),
    "carrier" VARCHAR(80),
    "notes" TEXT,
    "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "status" "CustomerStatus" NOT NULL DEFAULT 'AVAILABLE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "lastContactAt" TIMESTAMPTZ(3),
    "archivedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "customers_phone_hash_check" CHECK (char_length("phoneHash") = 64),
    CONSTRAINT "customers_phone_crypto_check" CHECK (octet_length("phoneIv") = 12 AND octet_length("phoneTag") = 16)
);

CREATE TABLE "assignments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "customerId" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "assignedById" UUID,
    "endedById" UUID,
    "status" "AssignmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "assignedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMPTZ(3),
    "endReason" VARCHAR(255),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "assignments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "allowed_device_models" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "manufacturer" VARCHAR(100) NOT NULL,
    "model" VARCHAR(120) NOT NULL,
    "androidSdk" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "allowed_device_models_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "allowed_device_models_android_sdk_check" CHECK ("androidSdk" >= 31)
);

CREATE TABLE "devices" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "allowedDeviceModelId" UUID,
    "installId" VARCHAR(128) NOT NULL,
    "displayName" VARCHAR(160),
    "manufacturer" VARCHAR(100) NOT NULL,
    "model" VARCHAR(120) NOT NULL,
    "androidVersion" VARCHAR(40) NOT NULL,
    "androidSdk" INTEGER NOT NULL,
    "appVersion" VARCHAR(40) NOT NULL,
    "appVersionCode" INTEGER NOT NULL,
    "status" "DeviceStatus" NOT NULL DEFAULT 'PENDING',
    "callPhonePermission" "PermissionState" NOT NULL DEFAULT 'UNKNOWN',
    "callLogPermission" "PermissionState" NOT NULL DEFAULT 'UNKNOWN',
    "lastHealthAt" TIMESTAMPTZ(3),
    "lastSyncCursor" BIGINT NOT NULL DEFAULT 0,
    "lastSyncAt" TIMESTAMPTZ(3),
    "activatedAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "devices_android_sdk_check" CHECK ("androidSdk" >= 31),
    CONSTRAINT "devices_app_version_code_check" CHECK ("appVersionCode" > 0)
);

CREATE TABLE "device_activations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "agentId" UUID NOT NULL,
    "createdById" UUID,
    "usedDeviceId" UUID,
    "codeHash" VARCHAR(64) NOT NULL,
    "status" "ActivationStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "usedAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_activations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "call_attempts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "assignmentId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "clientAttemptId" VARCHAR(128) NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "status" "AttemptStatus" NOT NULL DEFAULT 'PENDING',
    "dialTokenHash" VARCHAR(64),
    "dialTokenExpiresAt" TIMESTAMPTZ(3),
    "callLogBaselineId" VARCHAR(128),
    "callLogBaselineAt" TIMESTAMPTZ(3),
    "initiatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dialedAt" TIMESTAMPTZ(3),
    "collectingDeadlineAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "call_attempts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "call_attempts_attempt_number_check" CHECK ("attemptNumber" BETWEEN 1 AND 3)
);

CREATE TABLE "call_results" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "attemptId" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "eventId" VARCHAR(200),
    "source" "CallResultSource" NOT NULL,
    "durationSeconds" INTEGER,
    "systemCallLogId" VARCHAR(128),
    "systemCallStartedAt" TIMESTAMPTZ(3),
    "systemCallEndedAt" TIMESTAMPTZ(3),
    "matchedAt" TIMESTAMPTZ(3),
    "clientObservedAt" TIMESTAMPTZ(3),
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "call_results_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "call_results_duration_check" CHECK ("durationSeconds" IS NULL OR "durationSeconds" >= 0)
);

CREATE TABLE "suppression_entries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "phoneCiphertext" BYTEA NOT NULL,
    "phoneIv" BYTEA NOT NULL,
    "phoneTag" BYTEA NOT NULL,
    "phoneHash" VARCHAR(64) NOT NULL,
    "phoneMasked" VARCHAR(32) NOT NULL,
    "reason" VARCHAR(255),
    "source" "SuppressionSource" NOT NULL DEFAULT 'MANUAL',
    "createdById" UUID,
    "revokedById" UUID,
    "revokedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "suppression_entries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "suppression_entries_phone_hash_check" CHECK (char_length("phoneHash") = 64),
    CONSTRAINT "suppression_entries_phone_crypto_check" CHECK (octet_length("phoneIv") = 12 AND octet_length("phoneTag") = 16)
);

CREATE TABLE "import_jobs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "batchId" UUID,
    "createdById" UUID NOT NULL,
    "fileName" VARCHAR(255) NOT NULL,
    "objectKey" VARCHAR(512),
    "mode" "ImportMode" NOT NULL DEFAULT 'SKIP_DUPLICATES',
    "status" "ImportJobStatus" NOT NULL DEFAULT 'UPLOADED',
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "newRows" INTEGER NOT NULL DEFAULT 0,
    "updateRows" INTEGER NOT NULL DEFAULT 0,
    "duplicateRows" INTEGER NOT NULL DEFAULT 0,
    "invalidRows" INTEGER NOT NULL DEFAULT 0,
    "suppressedRows" INTEGER NOT NULL DEFAULT 0,
    "importedRows" INTEGER NOT NULL DEFAULT 0,
    "failedRows" INTEGER NOT NULL DEFAULT 0,
    "failureMessage" TEXT,
    "startedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "import_jobs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "import_jobs_counts_check" CHECK (
      "totalRows" >= 0 AND "newRows" >= 0 AND "updateRows" >= 0 AND
      "duplicateRows" >= 0 AND "invalidRows" >= 0 AND "suppressedRows" >= 0 AND
      "importedRows" >= 0 AND "failedRows" >= 0
    )
);

CREATE TABLE "import_rows" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "importJobId" UUID NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "status" "ImportRowStatus" NOT NULL,
    "phoneCiphertext" BYTEA,
    "phoneIv" BYTEA,
    "phoneTag" BYTEA,
    "phoneHash" VARCHAR(64),
    "phoneMasked" VARCHAR(32),
    "name" VARCHAR(160),
    "batchName" VARCHAR(160),
    "province" VARCHAR(80),
    "city" VARCHAR(80),
    "carrier" VARCHAR(80),
    "notes" TEXT,
    "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "issues" JSONB NOT NULL DEFAULT '[]',
    "createdCustomerId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_rows_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "import_rows_row_number_check" CHECK ("rowNumber" > 0)
);

CREATE TABLE "audit_events" (
    "id" BIGSERIAL NOT NULL,
    "actorId" UUID,
    "deviceId" UUID,
    "action" VARCHAR(120) NOT NULL,
    "entityType" VARCHAR(120) NOT NULL,
    "entityId" VARCHAR(128),
    "requestId" VARCHAR(128),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "sync_changes" (
    "cursor" BIGSERIAL NOT NULL,
    "targetUserId" UUID,
    "entityType" "SyncEntityType" NOT NULL,
    "entityId" UUID NOT NULL,
    "operation" "SyncOperation" NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_changes_pkey" PRIMARY KEY ("cursor")
);

CREATE TABLE "idempotency_records" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "actorId" UUID,
    "scope" VARCHAR(120) NOT NULL,
    "key" VARCHAR(200) NOT NULL,
    "requestHash" VARCHAR(64) NOT NULL,
    "status" "IdempotencyStatus" NOT NULL DEFAULT 'PROCESSING',
    "responseCode" INTEGER,
    "responseBody" JSONB,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "mobile_app_policies" (
    "id" VARCHAR(32) NOT NULL DEFAULT 'android',
    "minimumVersionCode" INTEGER NOT NULL DEFAULT 1,
    "latestVersionCode" INTEGER NOT NULL DEFAULT 1,
    "forceUpgrade" BOOLEAN NOT NULL DEFAULT false,
    "downloadUrl" VARCHAR(512),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "mobile_app_policies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");
CREATE INDEX "users_role_status_idx" ON "users"("role", "status");
CREATE UNIQUE INDEX "refresh_tokens_tokenHash_key" ON "refresh_tokens"("tokenHash");
CREATE INDEX "refresh_tokens_userId_expiresAt_idx" ON "refresh_tokens"("userId", "expiresAt");
CREATE UNIQUE INDEX "batches_code_key" ON "batches"("code");
CREATE INDEX "batches_status_createdAt_idx" ON "batches"("status", "createdAt");
CREATE UNIQUE INDEX "customers_phoneHash_key" ON "customers"("phoneHash");
CREATE INDEX "customers_batchId_status_createdAt_idx" ON "customers"("batchId", "status", "createdAt");
CREATE INDEX "customers_status_updatedAt_idx" ON "customers"("status", "updatedAt");
CREATE INDEX "assignments_customerId_status_idx" ON "assignments"("customerId", "status");
CREATE INDEX "assignments_agentId_status_assignedAt_idx" ON "assignments"("agentId", "status", "assignedAt");
CREATE UNIQUE INDEX "assignments_one_active_per_customer" ON "assignments"("customerId") WHERE "status" = 'ACTIVE';
CREATE UNIQUE INDEX "allowed_device_models_manufacturer_model_androidSdk_key" ON "allowed_device_models"("manufacturer", "model", "androidSdk");
CREATE INDEX "allowed_device_models_enabled_idx" ON "allowed_device_models"("enabled");
CREATE UNIQUE INDEX "devices_installId_key" ON "devices"("installId");
CREATE INDEX "devices_userId_status_idx" ON "devices"("userId", "status");
CREATE INDEX "devices_status_lastHealthAt_idx" ON "devices"("status", "lastHealthAt");
CREATE UNIQUE INDEX "devices_one_active_per_user" ON "devices"("userId") WHERE "status" = 'ACTIVE';
CREATE UNIQUE INDEX "device_activations_codeHash_key" ON "device_activations"("codeHash");
CREATE INDEX "device_activations_agentId_status_expiresAt_idx" ON "device_activations"("agentId", "status", "expiresAt");
CREATE UNIQUE INDEX "call_attempts_clientAttemptId_key" ON "call_attempts"("clientAttemptId");
CREATE UNIQUE INDEX "call_attempts_dialTokenHash_key" ON "call_attempts"("dialTokenHash");
CREATE UNIQUE INDEX "call_attempts_assignmentId_attemptNumber_key" ON "call_attempts"("assignmentId", "attemptNumber");
CREATE INDEX "call_attempts_agentId_initiatedAt_idx" ON "call_attempts"("agentId", "initiatedAt");
CREATE INDEX "call_attempts_customerId_initiatedAt_idx" ON "call_attempts"("customerId", "initiatedAt");
CREATE INDEX "call_attempts_status_collectingDeadlineAt_idx" ON "call_attempts"("status", "collectingDeadlineAt");
CREATE UNIQUE INDEX "call_results_attemptId_key" ON "call_results"("attemptId");
CREATE UNIQUE INDEX "call_results_eventId_key" ON "call_results"("eventId");
CREATE UNIQUE INDEX "call_results_deviceId_systemCallLogId_systemCallStartedAt_key" ON "call_results"("deviceId", "systemCallLogId", "systemCallStartedAt");
CREATE INDEX "call_results_systemCallStartedAt_idx" ON "call_results"("systemCallStartedAt");
CREATE INDEX "suppression_entries_phoneHash_revokedAt_idx" ON "suppression_entries"("phoneHash", "revokedAt");
CREATE INDEX "suppression_entries_createdAt_idx" ON "suppression_entries"("createdAt");
CREATE UNIQUE INDEX "suppression_entries_one_active_per_phone" ON "suppression_entries"("phoneHash") WHERE "revokedAt" IS NULL;
CREATE INDEX "import_jobs_status_createdAt_idx" ON "import_jobs"("status", "createdAt");
CREATE INDEX "import_jobs_createdById_createdAt_idx" ON "import_jobs"("createdById", "createdAt");
CREATE UNIQUE INDEX "import_rows_importJobId_rowNumber_key" ON "import_rows"("importJobId", "rowNumber");
CREATE INDEX "import_rows_importJobId_status_idx" ON "import_rows"("importJobId", "status");
CREATE INDEX "audit_events_entityType_entityId_createdAt_idx" ON "audit_events"("entityType", "entityId", "createdAt");
CREATE INDEX "audit_events_actorId_createdAt_idx" ON "audit_events"("actorId", "createdAt");
CREATE INDEX "audit_events_requestId_idx" ON "audit_events"("requestId");
CREATE INDEX "sync_changes_targetUserId_cursor_idx" ON "sync_changes"("targetUserId", "cursor");
CREATE INDEX "sync_changes_createdAt_idx" ON "sync_changes"("createdAt");
CREATE UNIQUE INDEX "idempotency_records_actorId_scope_key_key" ON "idempotency_records"("actorId", "scope", "key");
CREATE INDEX "idempotency_records_actorId_createdAt_idx" ON "idempotency_records"("actorId", "createdAt");
CREATE INDEX "idempotency_records_expiresAt_idx" ON "idempotency_records"("expiresAt");

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "batches" ADD CONSTRAINT "batches_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "customers" ADD CONSTRAINT "customers_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "customers" ADD CONSTRAINT "customers_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_endedById_fkey" FOREIGN KEY ("endedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "devices" ADD CONSTRAINT "devices_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "devices" ADD CONSTRAINT "devices_allowedDeviceModelId_fkey" FOREIGN KEY ("allowedDeviceModelId") REFERENCES "allowed_device_models"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "device_activations" ADD CONSTRAINT "device_activations_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "device_activations" ADD CONSTRAINT "device_activations_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "device_activations" ADD CONSTRAINT "device_activations_usedDeviceId_fkey" FOREIGN KEY ("usedDeviceId") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "call_attempts" ADD CONSTRAINT "call_attempts_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "assignments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "call_attempts" ADD CONSTRAINT "call_attempts_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "call_attempts" ADD CONSTRAINT "call_attempts_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "call_attempts" ADD CONSTRAINT "call_attempts_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "call_results" ADD CONSTRAINT "call_results_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "call_attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "suppression_entries" ADD CONSTRAINT "suppression_entries_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "suppression_entries" ADD CONSTRAINT "suppression_entries_revokedById_fkey" FOREIGN KEY ("revokedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_importJobId_fkey" FOREIGN KEY ("importJobId") REFERENCES "import_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "sync_changes" ADD CONSTRAINT "sync_changes_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
