ALTER TABLE "User"
  ADD COLUMN "employeeNumber" TEXT,
  ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "recoveryPinHash" TEXT;

CREATE UNIQUE INDEX "User_employeeNumber_key" ON "User"("employeeNumber");
CREATE INDEX "User_isActive_idx" ON "User"("isActive");
