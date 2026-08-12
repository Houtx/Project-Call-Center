CREATE TYPE "CallRecordingStatus" AS ENUM ('PENDING', 'UPLOADING', 'READY', 'FAILED', 'UNSUPPORTED', 'DELETED');

ALTER TABLE "users" ADD COLUMN "recordingEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "devices" ADD COLUMN "recordAudioPermission" "PermissionState" NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE "call_attempts" ADD COLUMN "recordingRequested" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "mobile_app_policies" ADD COLUMN "recordingRetentionDays" INTEGER NOT NULL DEFAULT 30;

CREATE TABLE "call_recordings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "attemptId" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "status" "CallRecordingStatus" NOT NULL DEFAULT 'PENDING',
    "objectKey" VARCHAR(512),
    "mimeType" VARCHAR(120),
    "sizeBytes" INTEGER,
    "durationSeconds" INTEGER,
    "sha256" VARCHAR(64),
    "failureCode" VARCHAR(120),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploadedAt" TIMESTAMPTZ(3),
    "deletedAt" TIMESTAMPTZ(3),
    "expiresAt" TIMESTAMPTZ(3),
    CONSTRAINT "call_recordings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "call_recordings_attemptId_key" ON "call_recordings"("attemptId");
CREATE INDEX "call_recordings_status_expiresAt_idx" ON "call_recordings"("status", "expiresAt");
CREATE INDEX "call_recordings_agentId_createdAt_idx" ON "call_recordings"("agentId", "createdAt");

ALTER TABLE "call_recordings" ADD CONSTRAINT "call_recordings_attemptId_fkey"
  FOREIGN KEY ("attemptId") REFERENCES "call_attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "call_recordings" ADD CONSTRAINT "call_recordings_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "call_recordings" ADD CONSTRAINT "call_recordings_deviceId_fkey"
  FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
