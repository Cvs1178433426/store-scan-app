ALTER TABLE "User"
  ADD COLUMN "recoveryFailureCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "recoveryLockedUntil" TIMESTAMP(3);

CREATE INDEX "User_recoveryLockedUntil_idx" ON "User"("recoveryLockedUntil");
