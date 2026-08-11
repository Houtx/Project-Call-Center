ALTER TABLE "mobile_app_policies"
  ADD COLUMN "maxCallAttempts" INTEGER NOT NULL DEFAULT 2;

ALTER TABLE "mobile_app_policies"
  ADD CONSTRAINT "mobile_app_policies_max_call_attempts_check"
  CHECK ("maxCallAttempts" BETWEEN 1 AND 10);

ALTER TABLE "call_attempts"
  DROP CONSTRAINT "call_attempts_attempt_number_check";

ALTER TABLE "call_attempts"
  ADD CONSTRAINT "call_attempts_attempt_number_check"
  CHECK ("attemptNumber" BETWEEN 1 AND 10);

-- The new default is immediately authoritative. Close existing active tasks
-- that already reached two completed unsuccessful attempts, but leave an
-- in-flight call alone so its eventual result can settle the assignment.
UPDATE "assignments" AS assignment
SET
  "status" = 'COMPLETED',
  "endedAt" = CURRENT_TIMESTAMP,
  "endReason" = 'ATTEMPT_LIMIT_POLICY',
  "updatedAt" = CURRENT_TIMESTAMP
WHERE assignment."status" = 'ACTIVE'
  AND EXISTS (
    SELECT 1
    FROM "call_attempts" AS attempt
    WHERE attempt."assignmentId" = assignment."id"
      AND attempt."attemptNumber" >= 2
      AND attempt."status" IN ('NOT_CONNECTED', 'UNKNOWN')
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "call_attempts" AS attempt
    WHERE attempt."assignmentId" = assignment."id"
      AND attempt."status" = 'COLLECTING'
  );

UPDATE "customers" AS customer
SET
  "status" = 'COMPLETED',
  "updatedAt" = CURRENT_TIMESTAMP
WHERE EXISTS (
  SELECT 1
  FROM "assignments" AS assignment
  WHERE assignment."customerId" = customer."id"
    AND assignment."endReason" = 'ATTEMPT_LIMIT_POLICY'
);

INSERT INTO "sync_changes" (
  "targetUserId",
  "entityType",
  "entityId",
  "operation",
  "payload"
)
SELECT
  assignment."agentId",
  'ASSIGNMENT'::"SyncEntityType",
  assignment."id",
  'REMOVE'::"SyncOperation",
  jsonb_build_object(
    'assignmentId', assignment."id",
    'reason', 'ATTEMPT_LIMIT_POLICY'
  )
FROM "assignments" AS assignment
WHERE assignment."endReason" = 'ATTEMPT_LIMIT_POLICY';
