CREATE TABLE "VerificationRateLimit" (
  "id" TEXT NOT NULL,
  "tenantScope" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "keyHash" TEXT NOT NULL,
  "windowStart" TIMESTAMP(3) NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 0,
  "limit" INTEGER NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "VerificationRateLimit_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "VerificationRateLimit_tenantScope_action_keyHash_windowStart_key"
  ON "VerificationRateLimit"("tenantScope", "action", "keyHash", "windowStart");
CREATE INDEX "VerificationRateLimit_expiresAt_idx" ON "VerificationRateLimit"("expiresAt");
