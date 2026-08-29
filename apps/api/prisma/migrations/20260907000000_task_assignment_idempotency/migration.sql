ALTER TABLE "TaskAssignment" ADD COLUMN "idempotencyKey" TEXT;
CREATE UNIQUE INDEX "TaskAssignment_organizationId_idempotencyKey_key" ON "TaskAssignment"("organizationId", "idempotencyKey");
