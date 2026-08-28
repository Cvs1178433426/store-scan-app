-- Align legacy session indexes with the current Prisma schema.

-- AuditSession: replace the old status-only index with the composite index
-- used by active audits scoped to a location, and add startedById lookup.
DROP INDEX IF EXISTS "AuditSession_status_idx";
CREATE INDEX IF NOT EXISTS "AuditSession_locationId_status_idx"
  ON "AuditSession"("locationId", "status");
CREATE INDEX IF NOT EXISTS "AuditSession_startedById_idx"
  ON "AuditSession"("startedById");

-- StoreCountSession: replace the old startedById-only index with the
-- composite index used to find a user's active session efficiently.
DROP INDEX IF EXISTS "StoreCountSession_startedById_idx";
CREATE INDEX IF NOT EXISTS "StoreCountSession_startedById_status_idx"
  ON "StoreCountSession"("startedById", "status");
