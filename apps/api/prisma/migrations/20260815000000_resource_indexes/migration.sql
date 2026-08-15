-- Query paths used by the default customer list, call list, dashboard and streamed exports.
CREATE INDEX "customers_createdAt_id_idx" ON "customers"("createdAt", "id");
CREATE INDEX "call_attempts_initiatedAt_id_idx" ON "call_attempts"("initiatedAt", "id");
CREATE INDEX "call_attempts_status_initiatedAt_idx" ON "call_attempts"("status", "initiatedAt");
