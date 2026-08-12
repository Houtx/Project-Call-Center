ALTER TABLE "customers"
ADD COLUMN "suppressionPreviousStatus" "CustomerStatus";

UPDATE "customers" AS customer
SET "suppressionPreviousStatus" = CASE
  WHEN EXISTS (
    SELECT 1
    FROM "assignments" AS assignment
    WHERE assignment."customerId" = customer."id"
      AND assignment."status" = 'SUPPRESSED'::"AssignmentStatus"
  ) THEN 'ASSIGNED'::"CustomerStatus"
  WHEN EXISTS (
    SELECT 1
    FROM "assignments" AS assignment
    WHERE assignment."customerId" = customer."id"
      AND assignment."status" = 'COMPLETED'::"AssignmentStatus"
  ) THEN 'COMPLETED'::"CustomerStatus"
  ELSE 'AVAILABLE'::"CustomerStatus"
END
WHERE customer."status" = 'SUPPRESSED'::"CustomerStatus";
